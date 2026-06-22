import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const uiStateMock = vi.hoisted(() => ({
  currentWorkspacePath: null as string | null,
}));

vi.mock('../../electron/utils/ui-state', () => ({
  readUiState: () => ({
    version: 1,
    updatedAt: Date.now(),
    workspaces: {
      currentWorkspaceId: uiStateMock.currentWorkspacePath ? 'test-workspace' : null,
      currentWorkspacePath: uiStateMock.currentWorkspacePath,
      temporaryWorkspaces: uiStateMock.currentWorkspacePath
        ? [{
            id: 'test-workspace',
            name: 'Test Workspace',
            agentId: 'temp',
            agentName: 'Test Workspace',
            path: uiStateMock.currentWorkspacePath,
            createdAt: Date.now(),
            lastAccessedAt: Date.now(),
          }]
        : [],
    },
    chat: {
      sessionWorkspaceIds: {},
      customSessionLabels: {},
    },
  }),
}));

import {
  assertGatewayRpcFilePathsAllowed,
  assertTextFilePathsAllowed,
  extractLocalFilePathReferences,
} from '../../electron/security/chat-file-path-preflight';
import { clearPathGrants } from '../../electron/security/permission-store';
import {
  registerSecurityConfirmationHandlers,
  resetSecurityConfirmationForTests,
} from '../../electron/security/confirmation-service';

async function makeTempRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'clawx-chat-path-preflight-'));
}

describe('chat local file path preflight', () => {
  beforeEach(() => {
    clearPathGrants();
    resetSecurityConfirmationForTests();
    uiStateMock.currentWorkspacePath = null;
  });

  function setupConfirmationHarness() {
    let handler: ((event: unknown, response: unknown) => Promise<unknown>) | null = null;
    const ipcMain = {
      handle: vi.fn((channel: string, nextHandler: typeof handler) => {
        if (channel === 'security:confirmation-response') handler = nextHandler;
      }),
    };
    const sent: unknown[] = [];
    const mainWindow = {
      isDestroyed: () => false,
      webContents: {
        send: vi.fn((_channel: string, payload: unknown) => {
          sent.push(payload);
        }),
      },
    };
    registerSecurityConfirmationHandlers(ipcMain as never, mainWindow as never);
    return {
      sent,
      respond: async (choice: 'deny' | 'allow-once' | 'allow-session' | 'allow-persistent') => {
        const request = sent[sent.length - 1] as { id: string };
        if (!handler) throw new Error('missing confirmation handler');
        await handler({}, { id: request.id, choice });
      },
    };
  }

  it('extracts local file paths embedded in natural-language messages', () => {
    expect(extractLocalFilePathReferences('读取一下D:\\测试2\\hello.txt有什么内容')).toEqual([
      'D:\\测试2\\hello.txt',
    ]);
    expect(extractLocalFilePathReferences('open file:///D:/test/hello.txt, please')).toEqual([
      'D:\\test\\hello.txt',
    ]);
  });

  it('does not swallow wrapping/trailing brackets into the path', () => {
    const dir = 'C:\\Users\\Leon.Long\\AppData\\Local\\Temp\\clawx-sec-test';
    // Models often write the path as [dir], (dir) or with a trailing ] — the
    // closing bracket must not become part of the path (would break root match).
    expect(extractLocalFilePathReferences(`read [${dir}]`)).toEqual([dir]);
    expect(extractLocalFilePathReferences(`the workspace is ${dir}]`)).toEqual([dir]);
    expect(extractLocalFilePathReferences(`(${dir})`)).toEqual([dir]);
  });

  it('allows a referenced file inside the current workspace', async () => {
    const workspace = await makeTempRoot();
    const filePath = join(workspace, 'hello.txt');
    await writeFile(filePath, 'hello', 'utf8');
    uiStateMock.currentWorkspacePath = workspace;

    await expect(assertTextFilePathsAllowed(`读取 ${filePath}`, 'test')).resolves.toBeUndefined();
  });

  it('allows the bracketed working-directory context for the current workspace', async () => {
    const workspace = await makeTempRoot();
    uiStateMock.currentWorkspacePath = workspace;

    await expect(
      assertTextFilePathsAllowed(`[Working Directory: ${workspace}]`, 'test'),
    ).resolves.toBeUndefined();
  });

  it('asks for confirmation before reading a referenced file outside the current workspace', async () => {
    const harness = setupConfirmationHarness();
    const workspace = await makeTempRoot();
    const outside = await makeTempRoot();
    const filePath = join(outside, 'hello.txt');
    await writeFile(filePath, 'outside', 'utf8');
    uiStateMock.currentWorkspacePath = workspace;

    const pending = assertTextFilePathsAllowed(`读取一下${filePath}有什么内容`, 'test');

    await expect.poll(() => harness.sent.length).toBe(1);
    expect(harness.sent[0]).toMatchObject({
      kind: 'file',
      target: {
        path: filePath,
        capability: 'read',
      },
    });
    await harness.respond('allow-once');
    await expect(pending).resolves.toBeUndefined();
  });

  it('denies a referenced outside file when the user rejects confirmation', async () => {
    const harness = setupConfirmationHarness();
    const workspace = await makeTempRoot();
    const outside = await makeTempRoot();
    const filePath = join(outside, 'hello.txt');
    await writeFile(filePath, 'outside', 'utf8');
    uiStateMock.currentWorkspacePath = workspace;

    const pending = assertTextFilePathsAllowed(`读取 ${filePath}`, 'test');

    await expect.poll(() => harness.sent.length).toBe(1);
    await harness.respond('deny');
    await expect(pending).rejects.toMatchObject({
      code: 'FILE_PATH_ACCESS_DENIED_BY_USER',
    });
  });

  it('denies sensitive paths even when they are inside the workspace', async () => {
    const harness = setupConfirmationHarness();
    const workspace = await makeTempRoot();
    const envPath = join(workspace, '.env');
    await writeFile(envPath, 'API_KEY=fake', 'utf8');
    uiStateMock.currentWorkspacePath = workspace;

    await expect(assertTextFilePathsAllowed(`读取 ${envPath}`, 'test')).rejects.toMatchObject({
      code: 'SENSITIVE_PATH',
    });
    expect(harness.sent).toHaveLength(0);
  });

  it('only checks chat.send gateway RPC messages', async () => {
    const workspace = await makeTempRoot();
    const outside = await makeTempRoot();
    const filePath = join(outside, 'hello.txt');
    await writeFile(filePath, 'outside', 'utf8');
    uiStateMock.currentWorkspacePath = workspace;

    await expect(assertGatewayRpcFilePathsAllowed('sessions.list', {
      message: `读取 ${filePath}`,
    })).resolves.toBeUndefined();

    const harness = setupConfirmationHarness();
    const pending = assertGatewayRpcFilePathsAllowed('chat.send', {
      message: `读取 ${filePath}`,
    });
    await expect.poll(() => harness.sent.length).toBe(1);
    await harness.respond('allow-once');
    await expect(pending).resolves.toBeUndefined();
  });

  it('does not treat mime types inside [media attached: ...] as part of the file path', () => {
    const outbound = 'C:\\Users\\peng.xue\\.openclaw\\media\\outbound\\419af6a5-1111-2222-3333-444444444444.jpg';
    const message = `Describe this\n\n[media attached: ${outbound} (image/jpeg) | ${outbound}]`;
    expect(extractLocalFilePathReferences(message)).toEqual([outbound]);
  });

  it('allows a directory reference inside the current workspace', async () => {
    const workspace = await makeTempRoot();
    const dirPath = join(workspace, 'docs');
    await mkdir(dirPath);
    uiStateMock.currentWorkspacePath = workspace;

    await expect(assertTextFilePathsAllowed(`列一下 ${dirPath}\\ 目录`, 'test')).resolves.toBeUndefined();
  });
});
