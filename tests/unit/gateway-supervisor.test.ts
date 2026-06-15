import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalPlatform = process.platform;

const {
  mockExec,
  mockCreateServer,
  mockFork,
  mockAssertTrustedInternalCommand,
  mockExistsSync,
  mockGetUvMirrorEnv,
  mockEnsureBundledNodeReady,
} = vi.hoisted(() => ({
  mockExec: vi.fn(),
  mockCreateServer: vi.fn(),
  mockFork: vi.fn(),
  mockAssertTrustedInternalCommand: vi.fn(),
  mockExistsSync: vi.fn(),
  mockGetUvMirrorEnv: vi.fn(),
  mockEnsureBundledNodeReady: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp',
  },
  utilityProcess: {
    fork: mockFork,
  },
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: mockExistsSync,
    default: {
      ...actual,
      existsSync: mockExistsSync,
    },
  };
});

vi.mock('child_process', () => ({
  exec: mockExec,
  execSync: vi.fn(),
  spawn: vi.fn(),
  default: {
    exec: mockExec,
    execSync: vi.fn(),
    spawn: vi.fn(),
  },
}));

vi.mock('net', () => ({
  createServer: mockCreateServer,
}));

vi.mock('@electron/utils/paths', () => ({
  getOpenClawDir: () => '/tmp/openclaw',
  getOpenClawEntryPath: () => '/tmp/openclaw/openclaw-entry.js',
}));

vi.mock('@electron/utils/uv-env', () => ({
  getUvMirrorEnv: mockGetUvMirrorEnv,
}));

vi.mock('@electron/utils/bundled-node', () => ({
  buildBundledNpmEnv: (env: Record<string, string | undefined>) => env,
  ensureBundledNodeReady: mockEnsureBundledNodeReady,
  getBundledBinDir: () => '/tmp/bundled-bin',
  hasBundledNpmRuntime: () => false,
  hasNpmCliRuntime: () => true,
}));

vi.mock('@electron/utils/env-path', () => ({
  prependPathEntry: (env: Record<string, string | undefined>) => ({ env }),
}));

vi.mock('@electron/utils/child-output-encoding', () => ({
  buildUtf8ChildProcessEnv: (env: Record<string, string | undefined>) => env,
  decodeChildProcessOutput: (data: Buffer | string) => Buffer.isBuffer(data) ? data.toString('utf8') : data,
}));

vi.mock('@electron/security/trusted-internal-command', () => ({
  assertTrustedInternalCommand: mockAssertTrustedInternalCommand,
}));

class MockUtilityChild extends EventEmitter {
  pid?: number;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();

  constructor(pid?: number) {
    super();
    this.pid = pid;
  }
}

function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, writable: true });
}

describe('gateway supervisor process cleanup', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    mockExec.mockImplementation((_cmd: string, _opts: object, cb: (err: Error | null, stdout: string) => void) => {
      cb(null, '');
      return {} as never;
    });
    mockExistsSync.mockReturnValue(true);
    mockGetUvMirrorEnv.mockResolvedValue({});
    mockAssertTrustedInternalCommand.mockReturnValue(undefined);

    mockCreateServer.mockImplementation(() => {
      const handlers = new Map<string, (...args: unknown[]) => void>();
      return {
        once(event: string, callback: (...args: unknown[]) => void) {
          handlers.set(event, callback);
          return this;
        },
        listen() {
          queueMicrotask(() => handlers.get('listening')?.());
          return this;
        },
        close(callback?: () => void) {
          callback?.();
        },
      };
    });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
  });

  it('uses taskkill tree strategy for owned process on Windows', async () => {
    setPlatform('win32');
    const child = new MockUtilityChild(4321);
    const { terminateOwnedGatewayProcess } = await import('@electron/gateway/supervisor');

    const stopPromise = terminateOwnedGatewayProcess(child as unknown as Electron.UtilityProcess);
    child.emit('exit', 0);
    await stopPromise;

    await vi.waitFor(() => {
      expect(mockExec).toHaveBeenCalledWith(
        'taskkill /F /PID 4321 /T',
        expect.objectContaining({ timeout: 5000, windowsHide: true }),
        expect.any(Function),
      );
    });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('uses direct child.kill for owned process on non-Windows', async () => {
    setPlatform('linux');
    const child = new MockUtilityChild(9876);
    const { terminateOwnedGatewayProcess } = await import('@electron/gateway/supervisor');

    const stopPromise = terminateOwnedGatewayProcess(child as unknown as Electron.UtilityProcess);
    child.emit('exit', 0);
    await stopPromise;

    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('guards explicit Gateway pid cleanup with the trusted internal command boundary on Windows', async () => {
    setPlatform('win32');
    const { terminateGatewayProcessByPid } = await import('@electron/gateway/supervisor');

    await terminateGatewayProcessByPid(4321, 'system:test-agent-delete');

    expect(mockAssertTrustedInternalCommand).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'gateway:process-tree-kill',
      executable: 'taskkill',
      args: ['/F', '/PID', '4321', '/T'],
      source: 'system:test-agent-delete',
    }));
    expect(mockExec).toHaveBeenCalledWith(
      'taskkill /F /PID 4321 /T',
      expect.objectContaining({ timeout: 5000, windowsHide: true }),
      expect.any(Function),
    );
  });

  it('guards explicit Gateway port cleanup with listener query and process kill checks', async () => {
    setPlatform('win32');
    const { terminateGatewayListenersOnPort } = await import('@electron/gateway/supervisor');

    mockExec.mockImplementation((cmd: string, _opts: object, cb: (err: Error | null, stdout: string) => void) => {
      if (cmd.includes('netstat -ano')) {
        cb(null, '  TCP    127.0.0.1:18789    0.0.0.0:0    LISTENING    4321\n');
        return {} as never;
      }
      cb(null, '');
      return {} as never;
    });

    await terminateGatewayListenersOnPort(18789);

    expect(mockAssertTrustedInternalCommand).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'gateway:listener-query',
      executable: 'netstat',
      args: ['18789'],
      source: 'system:gateway-port-cleanup',
    }));
    expect(mockAssertTrustedInternalCommand).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'gateway:process-tree-kill',
      executable: 'taskkill',
      args: ['/F', '/PID', '4321', '/T'],
      source: 'system:gateway-orphan-cleanup',
    }));
  });

  it('waits for port release after orphan cleanup on Windows', async () => {
    setPlatform('win32');
    const { findExistingGatewayProcess } = await import('@electron/gateway/supervisor');

    mockExec.mockImplementation((cmd: string, _opts: object, cb: (err: Error | null, stdout: string) => void) => {
      if (cmd.includes('netstat -ano')) {
        cb(null, '  TCP    127.0.0.1:18789    0.0.0.0:0    LISTENING    4321\n');
        return {} as never;
      }
      cb(null, '');
      return {} as never;
    });

    const result = await findExistingGatewayProcess({ port: 18789 });
    expect(result).toBeNull();

    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining('taskkill /F /PID 4321 /T'),
      expect.objectContaining({ timeout: 5000, windowsHide: true }),
      expect.any(Function),
    );
    expect(mockCreateServer).toHaveBeenCalled();
  });

  it('runs Gateway doctor repair after policy allows the app-owned repair command', async () => {
    const child = new MockUtilityChild();
    mockFork.mockReturnValue(child);
    const { runOpenClawDoctorRepair } = await import('@electron/gateway/supervisor');

    const resultPromise = runOpenClawDoctorRepair();

    await vi.waitFor(() => {
      expect(mockAssertTrustedInternalCommand).toHaveBeenCalledWith(expect.objectContaining({
        operation: 'gateway:doctor-repair',
        executable: 'openclaw',
        args: ['doctor', '--fix', '--yes', '--non-interactive'],
        cwd: '/tmp/openclaw',
        source: 'system:gateway-doctor-repair',
      }));
      expect(mockFork).toHaveBeenCalledWith(
        '/tmp/openclaw/openclaw-entry.js',
        ['doctor', '--fix', '--yes', '--non-interactive'],
        expect.objectContaining({ cwd: '/tmp/openclaw', stdio: 'pipe' }),
      );
    });

    child.emit('exit', 0);
    await expect(resultPromise).resolves.toBe(true);
  });

  it('does not start Gateway doctor repair when the internal command boundary rejects it', async () => {
    mockAssertTrustedInternalCommand.mockImplementationOnce(() => {
      throw new Error('Untrusted internal command');
    });
    const { runOpenClawDoctorRepair } = await import('@electron/gateway/supervisor');

    await expect(runOpenClawDoctorRepair()).resolves.toBe(false);

    expect(mockFork).not.toHaveBeenCalled();
  });
});
