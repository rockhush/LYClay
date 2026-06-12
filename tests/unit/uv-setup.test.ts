import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalPlatform = process.platform;
const originalResourcesPath = process.resourcesPath;

const {
  mockExecSync,
  mockSpawn,
  mockExistsSync,
  mockIsPackaged,
  mockResourcesPath,
} = vi.hoisted(() => ({
  mockExecSync: vi.fn(),
  mockSpawn: vi.fn(),
  mockExistsSync: vi.fn<(path: string) => boolean>(),
  mockIsPackaged: { value: false },
  mockResourcesPath: { value: 'C:\\Program Files\\LYClaw\\resources' },
}));

class MockChild extends EventEmitter {
  stdout = new EventEmitter();
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
  },
}));

vi.mock('child_process', () => ({
  execSync: mockExecSync,
  spawn: mockSpawn,
  default: {
    execSync: mockExecSync,
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

describe('uv setup managed Python environment', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockExecSync.mockReturnValue(undefined);
    mockExistsSync.mockReturnValue(false);
    mockIsPackaged.value = false;
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

  it('prepends uv-managed Python to PATH and pins OpenClaw helper Python', async () => {
    mockUvPythonFind('C:\\Uv Python\\python.exe');

    const { getManagedPythonEnv } = await import('@electron/utils/uv-setup');
    const env = await getManagedPythonEnv({ Path: 'C:\\Windows\\System32', OTHER: '1' });

    expect(env.Path).toBe('C:\\Uv Python;C:\\Uv Python\\Scripts;C:\\Windows\\System32');
    expect(env.OPENCLAW_PINNED_PYTHON).toBe('C:\\Uv Python\\python.exe');
    expect(env.OPENCLAW_PINNED_WRITE_PYTHON).toBe('C:\\Uv Python\\python.exe');
    expect(env.OTHER).toBe('1');
  });
});
