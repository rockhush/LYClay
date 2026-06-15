import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockSpawn,
  mockAssertCommandAllowedWithConfirmation,
} = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockAssertCommandAllowedWithConfirmation: vi.fn(),
}));

class MockChild extends EventEmitter {
  stderr = new EventEmitter();
}

vi.mock('electron', () => ({
  app: {
    getPath: () => join(tmpdir(), 'clawx-company-marketplace-security'),
  },
}));

vi.mock('child_process', () => ({
  spawn: mockSpawn,
  default: {
    spawn: mockSpawn,
  },
}));

vi.mock('@electron/security/confirmation-service', () => ({
  assertCommandAllowedWithConfirmation: mockAssertCommandAllowedWithConfirmation,
}));

describe('company marketplace archive command security', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockAssertCommandAllowedWithConfirmation.mockResolvedValue({
      decision: { action: 'allow', risk: 'low', reasons: ['test'] },
      segments: [],
      command: 'tar.exe -xf skill.zip',
    });
  });

  it('checks command security before extracting downloaded skill archives', async () => {
    const child = new MockChild();
    mockSpawn.mockReturnValue(child);
    const { createCompanyMarketplaceExtension } = await import('@electron/extensions/builtin/company-marketplace');
    const extension = createCompanyMarketplaceExtension() as unknown as {
      runArchiveCommand(command: string, args: string[]): Promise<void>;
    };

    const promise = extension.runArchiveCommand('tar.exe', ['-xf', 'skill.zip', '-C', 'skill']);

    await vi.waitFor(() => {
      expect(mockAssertCommandAllowedWithConfirmation).toHaveBeenCalledWith(expect.objectContaining({
        executable: 'tar.exe',
        args: ['-xf', 'skill.zip', '-C', 'skill'],
        source: 'skill:company-marketplace-archive',
        allowCwdOutsideWorkspace: true,
      }));
      expect(mockSpawn).toHaveBeenCalledTimes(1);
    });
    child.emit('close', 0);

    await expect(promise).resolves.toBeUndefined();
  });

  it('does not extract archives when command confirmation rejects it', async () => {
    mockAssertCommandAllowedWithConfirmation.mockRejectedValueOnce(new Error('Command execution denied'));
    const { createCompanyMarketplaceExtension } = await import('@electron/extensions/builtin/company-marketplace');
    const extension = createCompanyMarketplaceExtension() as unknown as {
      runArchiveCommand(command: string, args: string[]): Promise<void>;
    };

    await expect(extension.runArchiveCommand('tar.exe', ['-xf', 'skill.zip'])).rejects.toThrow('Command execution denied');

    expect(mockSpawn).not.toHaveBeenCalled();
  });
});
