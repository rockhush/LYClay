import { EventEmitter } from 'node:events';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  testRoot,
  mockSpawn,
  mockAssertCommandAllowedWithConfirmation,
} = vi.hoisted(() => ({
  testRoot: `C:\\tmp\\clawx-clawhub-security-${Math.random().toString(36).slice(2)}`,
  mockSpawn: vi.fn(),
  mockAssertCommandAllowedWithConfirmation: vi.fn(),
}));

class MockChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
}

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => testRoot,
  },
  shell: {
    openPath: vi.fn(),
  },
}));

vi.mock('child_process', () => ({
  spawn: mockSpawn,
  default: {
    spawn: mockSpawn,
  },
}));

vi.mock('@electron/utils/paths', async () => {
  const actual = await vi.importActual<typeof import('@electron/utils/paths')>('@electron/utils/paths');
  return {
    ...actual,
    getOpenClawConfigDir: () => join(testRoot, '.openclaw'),
    getClawHubCliBinPath: () => join(testRoot, 'bin', process.platform === 'win32' ? 'clawhub.cmd' : 'clawhub'),
    getClawHubCliEntryPath: () => join(testRoot, 'bin', 'clawdhub.js'),
  };
});

vi.mock('@electron/security/confirmation-service', () => ({
  assertCommandAllowedWithConfirmation: mockAssertCommandAllowedWithConfirmation,
}));

describe('ClawHub command security', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    await rm(testRoot, { recursive: true, force: true });
    await mkdir(join(testRoot, 'bin'), { recursive: true });
    await writeFile(join(testRoot, 'bin', process.platform === 'win32' ? 'clawhub.cmd' : 'clawhub'), '');
    await writeFile(join(testRoot, 'bin', 'clawdhub.js'), '');
    mockAssertCommandAllowedWithConfirmation.mockResolvedValue({
      decision: { action: 'allow', risk: 'medium', reasons: ['test'] },
      segments: [],
      command: 'clawhub install coding-agent',
      cwd: join(testRoot, '.openclaw'),
    });
  });

  it('checks command security before installing a skill', async () => {
    const child = new MockChild();
    mockSpawn.mockReturnValue(child);
    const { ClawHubService } = await import('@electron/gateway/clawhub');
    const service = new ClawHubService();

    const installPromise = service.install({ slug: 'coding-agent' });

    await vi.waitFor(() => {
      expect(mockAssertCommandAllowedWithConfirmation).toHaveBeenCalledWith(expect.objectContaining({
        args: ['install', 'coding-agent'],
        cwd: join(testRoot, '.openclaw'),
        source: 'skill:clawhub-cli',
        allowCwdOutsideWorkspace: true,
      }));
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });
    child.emit('close', 0);

    await expect(installPromise).resolves.toBeUndefined();
  });

  it('does not spawn ClawHub when command confirmation rejects the install', async () => {
    mockAssertCommandAllowedWithConfirmation.mockRejectedValueOnce(new Error('Command execution denied'));
    const { ClawHubService } = await import('@electron/gateway/clawhub');
    const service = new ClawHubService();

    await expect(service.install({ slug: 'coding-agent' })).rejects.toThrow('Command execution denied');

    expect(mockSpawn).not.toHaveBeenCalled();
  });
});
