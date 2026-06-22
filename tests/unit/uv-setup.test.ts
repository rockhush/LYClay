import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalPlatform = process.platform;
const originalResourcesPath = process.resourcesPath;

const {
  mockExecFileSync,
  mockSpawn,
  mockExistsSync,
  mockIsPackaged,
  mockResourcesPath,
  mockAssertCommandAllowedWithConfirmation,
} = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
  mockSpawn: vi.fn(),
  mockExistsSync: vi.fn<(path: string) => boolean>(),
  mockIsPackaged: { value: false },
  mockResourcesPath: { value: 'C:\\Program Files\\LYClaw\\resources' },
  mockAssertCommandAllowedWithConfirmation: vi.fn(),
}));

class MockChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, writable: true });
}

function mockUvPythonFind(pythonPath: string, code = 0): void {
  mockSpawn.mockImplementation(() => {
    const child = new MockChild();
    queueMicrotask(() => {
      if (pythonPath) child.stdout.emit('data', `${pythonPath}\n`);
      child.emit('close', code);
    });
    return child;
  });
}

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return mockIsPackaged.value;
    },
    isReady: () => true,
    whenReady: () => Promise.resolve(),
  },
}));

vi.mock('child_process', () => ({
  execFileSync: mockExecFileSync,
  spawn: mockSpawn,
  default: {
    execFileSync: mockExecFileSync,
    spawn: mockSpawn,
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

vi.mock('@electron/security/confirmation-service', () => ({
  assertCommandAllowedWithConfirmation: mockAssertCommandAllowedWithConfirmation,
}));

vi.mock('@electron/utils/uv-env', () => ({
  getUvMirrorEnv: vi.fn().mockResolvedValue({}),
}));

describe('uv setup managed Python environment', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockExecFileSync.mockReturnValue(undefined);
    mockExistsSync.mockReturnValue(false);
    mockIsPackaged.value = false;
    mockAssertCommandAllowedWithConfirmation.mockResolvedValue({
      decision: { action: 'allow', risk: 'medium', reasons: ['test'] },
      segments: [],
      command: 'uv python install 3.12',
    });
    Object.defineProperty(process, 'resourcesPath', {
      value: mockResourcesPath.value,
      configurable: true,
      writable: true,
    });
    setPlatform('win32');
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
    Object.defineProperty(process, 'resourcesPath', {
      value: originalResourcesPath,
      configurable: true,
      writable: true,
    });
  });

  it('finds only uv-managed Python without triggering downloads', async () => {
    mockUvPythonFind('C:\\Users\\me\\AppData\\Roaming\\uv\\python\\cpython-3.12\\python.exe');

    const { findManagedPythonPath } = await import('@electron/utils/uv-setup');

    await expect(findManagedPythonPath()).resolves.toBe('C:\\Users\\me\\AppData\\Roaming\\uv\\python\\cpython-3.12\\python.exe');
    expect(mockSpawn).toHaveBeenCalledWith(
      'uv',
      ['python', 'find', '3.12', '--managed-python', '--no-python-downloads'],
      expect.objectContaining({ shell: true, windowsHide: true }),
    );
  });

  it('uses legacy nested dev uv path when uv is not on PATH', async () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not found');
    });
    mockExistsSync.mockImplementation((p: string) => /[\\/]resources[\\/]bin[\\/]uv[\\/]win32-x64[\\/]uv\.exe$/i.test(p));
    mockUvPythonFind('C:\\Users\\me\\AppData\\Roaming\\uv\\python\\cpython-3.12\\python.exe');

    const { findManagedPythonPath } = await import('@electron/utils/uv-setup');

    await expect(findManagedPythonPath()).resolves.toBe('C:\\Users\\me\\AppData\\Roaming\\uv\\python\\cpython-3.12\\python.exe');
    expect(mockSpawn).toHaveBeenCalledWith(
      'D:\\code\\ClawX\\resources\\bin\\uv\\win32-x64\\uv.exe',
      ['python', 'find', '3.12', '--managed-python', '--no-python-downloads'],
      expect.objectContaining({ shell: false, windowsHide: true }),
    );
  });

  it('uses direct executable invocation for packaged bundled uv.exe', async () => {
    mockIsPackaged.value = true;
    mockExistsSync.mockImplementation((p: string) => /[\\/]bin[\\/]uv\.exe$/i.test(p));
    mockUvPythonFind('C:\\Users\\me\\AppData\\Roaming\\uv\\python\\cpython-3.12\\python.exe');

    const { findManagedPythonPath } = await import('@electron/utils/uv-setup');

    await expect(findManagedPythonPath()).resolves.toBe('C:\\Users\\me\\AppData\\Roaming\\uv\\python\\cpython-3.12\\python.exe');
    expect(mockSpawn).toHaveBeenCalledWith(
      'C:\\Program Files\\LYClaw\\resources\\bin\\uv.exe',
      ['python', 'find', '3.12', '--managed-python', '--no-python-downloads'],
      expect.objectContaining({ shell: false, windowsHide: true }),
    );
  });

  it('prefers Python bundled in the installed app resources', async () => {
    mockIsPackaged.value = true;
    mockExistsSync.mockImplementation((p: string) => (
      /[\\/]bin[\\/]uv\.exe$/i.test(p)
      || /[\\/]resources[\\/]python$/i.test(p)
    ));
    mockUvPythonFind('C:\\Program Files\\LYClaw\\resources\\resources\\python\\cpython-3.12\\python.exe');

    const { findManagedPythonPath } = await import('@electron/utils/uv-setup');

    await expect(findManagedPythonPath()).resolves.toBe(
      'C:\\Program Files\\LYClaw\\resources\\resources\\python\\cpython-3.12\\python.exe',
    );
    expect(mockSpawn).toHaveBeenCalledOnce();
    expect(mockSpawn).toHaveBeenCalledWith(
      'C:\\Program Files\\LYClaw\\resources\\bin\\uv.exe',
      ['python', 'find', '3.12', '--managed-python', '--no-python-downloads'],
      expect.objectContaining({
        env: expect.objectContaining({
          UV_PYTHON_INSTALL_DIR: 'C:\\Program Files\\LYClaw\\resources\\resources\\python',
        }),
        shell: false,
        windowsHide: true,
      }),
    );
  });

  it('falls back to the user-managed uv directory when bundled Python is unusable', async () => {
    mockIsPackaged.value = true;
    mockExistsSync.mockImplementation((p: string) => (
      /[\\/]bin[\\/]uv\.exe$/i.test(p)
      || /[\\/]resources[\\/]python$/i.test(p)
    ));
    mockSpawn
      .mockImplementationOnce(() => {
        const child = new MockChild();
        queueMicrotask(() => child.emit('close', 1));
        return child;
      })
      .mockImplementationOnce(() => {
        const child = new MockChild();
        queueMicrotask(() => {
          child.stdout.emit('data', 'C:\\Users\\me\\AppData\\Roaming\\uv\\python\\cpython-3.12\\python.exe\n');
          child.emit('close', 0);
        });
        return child;
      });

    const { findManagedPythonPath } = await import('@electron/utils/uv-setup');

    await expect(findManagedPythonPath()).resolves.toBe(
      'C:\\Users\\me\\AppData\\Roaming\\uv\\python\\cpython-3.12\\python.exe',
    );
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(mockSpawn.mock.calls[0]?.[2]).toEqual(expect.objectContaining({
      env: expect.objectContaining({
        UV_PYTHON_INSTALL_DIR: 'C:\\Program Files\\LYClaw\\resources\\resources\\python',
      }),
    }));
    expect(mockSpawn.mock.calls[1]?.[2]).toEqual(expect.objectContaining({ env: undefined }));
  });

  it('does not install Python when a managed runtime is already available', async () => {
    mockUvPythonFind('C:\\Users\\me\\AppData\\Roaming\\uv\\python\\cpython-3.12\\python.exe');

    const { setupManagedPython } = await import('@electron/utils/uv-setup');

    await expect(setupManagedPython()).resolves.toBeUndefined();
    expect(mockSpawn).toHaveBeenCalledOnce();
    expect(mockSpawn).toHaveBeenCalledWith(
      'uv',
      ['python', 'find', '3.12', '--managed-python', '--no-python-downloads'],
      expect.anything(),
    );
  });

  it('prepends uv-managed Python to PATH and pins OpenClaw helper Python', async () => {
    mockUvPythonFind('C:\\Uv Python\\python.exe');

    const { getManagedPythonEnv } = await import('@electron/utils/uv-setup');
    const env = await getManagedPythonEnv({ Path: 'C:\\Windows\\System32', OTHER: '1' });

    expect(env.Path).toBe('C:\\Uv Python;C:\\Uv Python\\Scripts;C:\\Windows\\System32');
    expect(env.OPENCLAW_PINNED_PYTHON).toBe('C:\\Uv Python\\python.exe');
    expect(env.OPENCLAW_PINNED_WRITE_PYTHON).toBe('C:\\Uv Python\\python.exe');
    expect(env.OTHER).toBe('1');
  });

  it('checks command security before installing managed Python', async () => {
    const children: MockChild[] = [];
    mockSpawn.mockImplementation(() => {
      const child = new MockChild();
      children.push(child);
      return child;
    });

    const { setupManagedPython } = await import('@electron/utils/uv-setup');
    const setupPromise = setupManagedPython();
    await vi.waitFor(() => {
      expect(mockSpawn).toHaveBeenCalledWith(
        'uv',
        ['python', 'find', '3.12', '--managed-python', '--no-python-downloads'],
        expect.anything(),
      );
    });
    children[0]?.emit('close', 1);

    await vi.waitFor(() => {
      expect(mockAssertCommandAllowedWithConfirmation).toHaveBeenCalledWith(expect.objectContaining({
        executable: 'uv',
        args: ['python', 'install', '3.12'],
        source: 'system:uv-python-install',
        allowCwdOutsideWorkspace: true,
      }));
      expect(mockSpawn).toHaveBeenCalledWith(
        'uv',
        ['python', 'install', '3.12'],
        expect.objectContaining({ shell: true, windowsHide: true }),
      );
    });
    children[1]?.emit('close', 0);
    await vi.waitFor(() => {
      expect(mockSpawn).toHaveBeenCalledTimes(3);
    });
    children[2]?.stdout.emit('data', 'C:\\Uv Python\\python.exe\n');
    children[2]?.emit('close', 0);

    await expect(setupPromise).resolves.toBeUndefined();
  });

  it('does not spawn uv install when command confirmation rejects it', async () => {
    mockAssertCommandAllowedWithConfirmation.mockRejectedValueOnce(new Error('Command execution denied'));
    mockSpawn.mockImplementation(() => {
      const child = new MockChild();
      queueMicrotask(() => child.emit('close', 1));
      return child;
    });

    const { setupManagedPython } = await import('@electron/utils/uv-setup');

    await expect(setupManagedPython()).rejects.toThrow('Command execution denied');
    expect(mockSpawn).toHaveBeenCalledOnce();
  });
});
