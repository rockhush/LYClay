// @vitest-environment node
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { EventEmitter } from 'events';
import { join } from 'path';
import { PassThrough } from 'stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileMock, execSyncMock, spawnMock, testHome } = vi.hoisted(() => {
  const suffix = Math.random().toString(36).slice(2);
  return {
    execFileMock: vi.fn(),
    execSyncMock: vi.fn(),
    spawnMock: vi.fn(),
    testHome: `/tmp/clawx-dws-auth-${suffix}`,
  };
});

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  const mocked = {
    ...actual,
    homedir: () => testHome,
  };
  return {
    ...mocked,
    default: mocked,
  };
});

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp/clawx-test-user-data',
    getVersion: () => '0.0.0-test',
    getAppPath: () => '/tmp',
  },
}));

vi.mock('child_process', () => ({
  execFile: execFileMock,
  execSync: execSyncMock,
  spawn: spawnMock,
}));

describe('DWS auth helper', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    vi.resetModules();
    await rm(testHome, { recursive: true, force: true });
    const dwsDir = join(testHome, '.dws');
    await mkdir(dwsDir, { recursive: true });
    await writeFile(join(dwsDir, process.platform === 'win32' ? 'dws.exe' : 'dws'), '');
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(null, '{"success":true}', '');
    });
    execSyncMock.mockReturnValue('{"success":true,"authenticated":true}');
  });

  it('authenticates DWS with an existing DingTalk access token', async () => {
    const { authenticateDwsCliWithToken } = await import('@electron/utils/dws-auth');

    const result = await authenticateDwsCliWithToken({
      accessToken: 'ding-access-token',
    });

    expect(result).toMatchObject({
      success: true,
      authenticated: true,
    });

    const appJson = JSON.parse(
      await readFile(join(testHome, '.dws', 'app.json'), 'utf-8'),
    ) as { clientId?: string; clientSecret?: string };
    expect(appJson.clientId).toBe('dingmbw5n9ktkkbbjv3g');
    expect(appJson.clientSecret).toBe('');

    expect(execFileMock).toHaveBeenCalledWith(
      join(testHome, '.dws', process.platform === 'win32' ? 'dws.exe' : 'dws'),
      [
        'auth',
        'login',
        '--token',
        'ding-access-token',
        '--client-id',
        'dingmbw5n9ktkkbbjv3g',
        '--yes',
        '--format',
        'json',
      ],
      expect.objectContaining({
        encoding: 'utf-8',
        windowsHide: true,
        env: expect.objectContaining({
          DWS_ACCESS_TOKEN: 'ding-access-token',
        }),
      }),
      expect.any(Function),
    );
    expect(execSyncMock).toHaveBeenCalled();
  });

  it('keeps an existing DWS app client instead of overwriting it with ClawX OAuth credentials', async () => {
    const { mkdir, writeFile } = await import('fs/promises');
    const dwsDir = join(testHome, '.dws');
    await mkdir(dwsDir, { recursive: true });
    await writeFile(
      join(dwsDir, 'app.json'),
      JSON.stringify({
        clientId: 'existing-dws-client',
        clientSecret: '',
        createdAt: '2026-05-14T16:28:13.8847455+08:00',
        updatedAt: '2026-05-14T16:28:13.8847455+08:00',
      }),
      'utf-8',
    );

    const { authenticateDwsCliWithToken } = await import('@electron/utils/dws-auth');

    await authenticateDwsCliWithToken({
      accessToken: 'ding-access-token',
    });

    const appJson = JSON.parse(
      await readFile(join(testHome, '.dws', 'app.json'), 'utf-8'),
    ) as { clientId?: string; clientSecret?: string; createdAt?: string };
    expect(appJson.clientId).toBe('existing-dws-client');
    expect(appJson.clientSecret).toBe('');
    expect(appJson.createdAt).toBe('2026-05-14T16:28:13.8847455+08:00');

    expect(execFileMock).toHaveBeenCalledWith(
      join(testHome, '.dws', process.platform === 'win32' ? 'dws.exe' : 'dws'),
      expect.arrayContaining(['--client-id', 'existing-dws-client']),
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('starts a DWS-managed login session and resolves the DingTalk authorization URL', async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn();
    spawnMock.mockReturnValue(child);
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(null, JSON.stringify({
        result: {
          userid: 'user-123',
          unionid: 'union-123',
          name: 'Leon',
        },
      }), '');
    });

    const { startDwsCliLoginSession } = await import('@electron/utils/dws-auth');
    const sessionPromise = startDwsCliLoginSession();
    child.stdout.write('Please visit:\n  https://login.dingtalk.com/oauth2/auth?client_id=dingmbw5n9ktkkbbjv3g&redirect_uri=http%3A%2F%2F127.0.0.1%3A3121%2Fcallback\n');
    const session = await sessionPromise;
    child.emit('close', 0);
    const result = await session.result;

    expect(session.authorizeUrl).toContain('client_id=dingmbw5n9ktkkbbjv3g');
    expect(spawnMock).toHaveBeenCalledWith(
      join(testHome, '.dws', process.platform === 'win32' ? 'dws.exe' : 'dws'),
      ['auth', 'login', '--force', '--no-browser', '--format', 'json'],
      expect.objectContaining({ windowsHide: true }),
    );
    expect(result.user).toMatchObject({
      userId: 'user-123',
      unionId: 'union-123',
      name: 'Leon',
    });
  });

  it('uses org employee user name instead of role label name from DWS get-self', async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn();
    spawnMock.mockReturnValue(child);
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(null, JSON.stringify({
        result: [{
          isAdmin: true,
          orgEmployeeModel: {
            corpId: 'ding5f10cf4fee1d08ab',
            labels: [{ name: '子管理员' }],
            orgName: '领益科技(深圳)有限公司',
            orgUserName: 'Leon/龙鸣',
            userId: '11427192',
          },
        }],
        success: true,
      }), '');
    });

    const { startDwsCliLoginSession } = await import('@electron/utils/dws-auth');
    const sessionPromise = startDwsCliLoginSession();
    child.stdout.write('https://login.dingtalk.com/oauth2/auth?client_id=dingmbw5n9ktkkbbjv3g&redirect_uri=http%3A%2F%2F127.0.0.1%3A3121%2Fcallback\n');
    const session = await sessionPromise;
    child.emit('close', 0);
    const result = await session.result;

    expect(result.user.name).toBe('Leon/龙鸣');
    expect(result.user.corpName).toBe('领益科技(深圳)有限公司');
    expect(result.user.userId).toBe('11427192');
  });
});
