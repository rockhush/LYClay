import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertCommandAllowedWithConfirmation,
  assertFileOperationAllowedWithConfirmation,
  assertNetworkAllowedWithConfirmation,
  assertMcpServerAllowedWithConfirmation,
  assertOpenTargetAllowedWithConfirmation,
  assertSkillWorkshopActionAllowedWithConfirmation,
  registerSecurityConfirmationHandlers,
  resetSecurityConfirmationForTests,
} from '@electron/security/confirmation-service';
import {
  findCommandGrant,
  findDomainGrant,
  findMcpServerGrant,
  findPathGrant,
  grantPathAccess,
  listAllCommandGrants,
  listAllPathGrants,
  resetPermissionStoreForTests,
} from '@electron/security/permission-store';
import { setSecurityModeForTests } from '@electron/security/security-mode';

async function useTempPermissionFile(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'clawx-confirmation-'));
  process.env.CLAWX_SECURITY_PERMISSIONS_PATH = join(root, 'security-permissions.json');
  resetPermissionStoreForTests();
  resetSecurityConfirmationForTests();
}

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
    respond: async (choice: 'deny' | 'allow-once' | 'allow-session' | 'allow-persistent', index = sent.length - 1) => {
      const request = sent[index] as { id: string };
      if (!handler) throw new Error('missing handler');
      await handler({}, { id: request.id, choice });
    },
  };
}

describe('security confirmation service', () => {
  beforeEach(async () => {
    await useTempPermissionFile();
    setSecurityModeForTests('standard');
  });

  afterEach(() => {
    setSecurityModeForTests(null);
  });

  it('asks for one-time confirmation before applying a Skill Workshop proposal in standard mode', async () => {
    setSecurityModeForTests('standard');
    const harness = setupConfirmationHarness();
    const pending = assertSkillWorkshopActionAllowedWithConfirmation({
      action: 'apply',
      title: 'Apply workspace skill proposal',
      description: 'Update the weekly report output.',
      toolCallId: 'tool-call-1',
    });

    await expect.poll(() => harness.sent.length).toBe(1);
    expect(harness.sent[0]).toMatchObject({
      kind: 'skill-workshop',
      target: {
        action: 'apply',
        title: 'Apply workspace skill proposal',
        toolCallId: 'tool-call-1',
      },
    });
    await harness.respond('allow-once');

    await expect(pending).resolves.toBeUndefined();
  });

  it.each(['trusted', 'off'] as const)('allows Skill Workshop actions without prompting in %s mode', async (mode) => {
    setSecurityModeForTests(mode);
    const harness = setupConfirmationHarness();

    await expect(assertSkillWorkshopActionAllowedWithConfirmation({
      action: 'apply',
      title: 'Apply workspace skill proposal',
    })).resolves.toBeUndefined();
    expect(harness.sent).toHaveLength(0);
  });

  it('allows one request after allow-once without writing a domain grant', async () => {
    const harness = setupConfirmationHarness();
    const pending = assertNetworkAllowedWithConfirmation({
      url: 'https://www.baidu.com/',
      source: 'gateway:rpc:chat.send',
    });

    await expect.poll(() => harness.sent.length).toBe(1);
    await harness.respond('allow-once');

    await expect(pending).resolves.toMatchObject({
      matchedRule: 'confirmed-once',
      decision: { action: 'allow' },
    });
    expect(await findDomainGrant('www.baidu.com')).toBeNull();
  });

  it('writes persistent domain grants after persistent confirmation', async () => {
    const harness = setupConfirmationHarness();
    const pending = assertNetworkAllowedWithConfirmation({
      url: 'https://www.baidu.com/',
      source: 'gateway:rpc:chat.send',
    });

    await expect.poll(() => harness.sent.length).toBe(1);
    await harness.respond('allow-persistent');
    await pending;

    const grant = await findDomainGrant('www.baidu.com');
    expect(grant).toMatchObject({
      domain: 'www.baidu.com',
      scope: 'persistent',
      source: 'security-confirmation',
    });
  });

  it('denies when the user rejects the confirmation', async () => {
    const harness = setupConfirmationHarness();
    const pending = assertNetworkAllowedWithConfirmation({
      url: 'https://www.baidu.com/',
      source: 'gateway:rpc:chat.send',
    });

    await expect.poll(() => harness.sent.length).toBe(1);
    await harness.respond('deny');

    await expect(pending).rejects.toMatchObject({
      code: 'NETWORK_ACCESS_DENIED_BY_USER',
    });
  });

  it('allows a command once without storing a session grant', async () => {
    const harness = setupConfirmationHarness();
    const pending = assertCommandAllowedWithConfirmation({
      command: 'openclaw doctor --fix --yes --non-interactive',
      cwd: '/tmp/openclaw',
      source: 'renderer:openclaw-doctor',
      allowCwdOutsideWorkspace: true,
    });

    await expect.poll(() => harness.sent.length).toBe(1);
    expect(harness.sent[0]).toMatchObject({
      kind: 'command',
      target: { command: 'openclaw doctor --fix --yes --non-interactive' },
    });
    await harness.respond('allow-once');

    await expect(pending).resolves.toMatchObject({
      command: 'openclaw doctor --fix --yes --non-interactive',
      decision: { action: 'allow' },
    });
    expect(await listAllCommandGrants()).toHaveLength(0);

    const secondPending = assertCommandAllowedWithConfirmation({
      command: 'openclaw doctor --fix --yes --non-interactive',
      cwd: '/tmp/openclaw',
      source: 'renderer:openclaw-doctor',
      allowCwdOutsideWorkspace: true,
    });
    await expect.poll(() => harness.sent.length).toBe(2);
    await harness.respond('deny');
    await expect(secondPending).rejects.toMatchObject({
      code: 'COMMAND_EXECUTION_DENIED_BY_USER',
    });
  });

  it('remembers command approvals for this app session', async () => {
    const harness = setupConfirmationHarness();
    const request = {
      command: 'openclaw doctor --fix --yes --non-interactive',
      cwd: '/tmp/openclaw',
      source: 'renderer:openclaw-doctor',
      allowCwdOutsideWorkspace: true,
    };
    const pending = assertCommandAllowedWithConfirmation(request);

    await expect.poll(() => harness.sent.length).toBe(1);
    await harness.respond('allow-session');
    await pending;

    await expect(findCommandGrant(request)).resolves.toMatchObject({
      command: request.command,
      cwd: request.cwd,
      scope: 'session',
      source: request.source,
    });
    await expect(assertCommandAllowedWithConfirmation(request)).resolves.toMatchObject({
      decision: { action: 'allow' },
    });
    expect(harness.sent).toHaveLength(1);
  });

  it('persists command approvals when the user chooses persistent allow', async () => {
    const harness = setupConfirmationHarness();
    const request = {
      command: 'npx some-remote-tool',
      cwd: '/tmp/openclaw',
      source: 'gateway:runtime-exec',
      allowCwdOutsideWorkspace: true,
    };
    const pending = assertCommandAllowedWithConfirmation(request);

    await expect.poll(() => harness.sent.length).toBe(1);
    await harness.respond('allow-persistent');
    await pending;

    await expect(findCommandGrant(request)).resolves.toMatchObject({
      command: request.command,
      scope: 'persistent',
      source: request.source,
    });
  });

  it('blocks command execution when the user rejects the confirmation', async () => {
    const harness = setupConfirmationHarness();
    const pending = assertCommandAllowedWithConfirmation({
      command: 'npx some-remote-tool',
      cwd: '/tmp/openclaw',
      source: 'renderer:test',
      allowCwdOutsideWorkspace: true,
    });

    await expect.poll(() => harness.sent.length).toBe(1);
    await harness.respond('deny');

    await expect(pending).rejects.toMatchObject({
      code: 'COMMAND_EXECUTION_DENIED_BY_USER',
    });
  });

  it('confirms prompt-level open targets before allowing them', async () => {
    const harness = setupConfirmationHarness();
    const pending = assertOpenTargetAllowedWithConfirmation({
      target: 'mailto:test@example.com',
      capability: 'open-external',
      source: 'renderer:shell.openExternal',
    });

    await expect.poll(() => harness.sent.length).toBe(1);
    expect(harness.sent[0]).toMatchObject({
      kind: 'open-target',
      target: { url: 'mailto:test@example.com', protocol: 'mailto:' },
    });
    await harness.respond('allow-once');

    await expect(pending).resolves.toMatchObject({
      action: 'open-url',
      decision: { action: 'allow' },
    });
  });

  it('remembers open target approvals for this app session', async () => {
    const harness = setupConfirmationHarness();
    const request = {
      target: 'mailto:test@example.com',
      capability: 'open-external' as const,
      source: 'renderer:shell.openExternal',
    };
    const pending = assertOpenTargetAllowedWithConfirmation(request);

    await expect.poll(() => harness.sent.length).toBe(1);
    await harness.respond('allow-session');
    await pending;

    await expect(assertOpenTargetAllowedWithConfirmation(request)).resolves.toMatchObject({
      matchedRule: 'confirmed-open-target-session',
      decision: { action: 'allow' },
    });
    expect(harness.sent).toHaveLength(1);
  });

  it('remembers open target approvals for the current domain during this app session', async () => {
    const harness = setupConfirmationHarness();
    const firstRequest = {
      target: 'http://news.example.com/article/one',
      capability: 'open-external' as const,
      source: 'renderer:shell.openExternal',
    };
    const pending = assertOpenTargetAllowedWithConfirmation(firstRequest);

    await expect.poll(() => harness.sent.length).toBe(1);
    await harness.respond('allow-session');
    await pending;

    await expect(findDomainGrant('news.example.com')).resolves.toMatchObject({
      domain: 'news.example.com',
      includeSubdomains: false,
      scope: 'session',
      source: 'security-confirmation',
    });
    await expect(assertOpenTargetAllowedWithConfirmation({
      ...firstRequest,
      target: 'http://news.example.com/article/two',
    })).resolves.toMatchObject({
      matchedRule: 'domain-grant',
      decision: { action: 'allow' },
    });
    expect(harness.sent).toHaveLength(1);

    const otherDomain = assertOpenTargetAllowedWithConfirmation({
      ...firstRequest,
      target: 'http://other.example.com/article/three',
    });
    await expect.poll(() => harness.sent.length).toBe(2);
    await harness.respond('deny');
    await expect(otherDomain).rejects.toMatchObject({
      code: 'OPEN_TARGET_DENIED_BY_USER',
    });
  });

  it('requires high-risk confirmation for stdio MCP servers and remembers the grant', async () => {
    const harness = setupConfirmationHarness();
    const server = { command: 'npx', args: ['-y', '@example/mcp'] };
    const pending = assertMcpServerAllowedWithConfirmation({
      serverName: 'example',
      server,
      source: 'settings:mcp-enable',
    });

    await expect.poll(() => harness.sent.length).toBe(1);
    expect(harness.sent[0]).toMatchObject({
      kind: 'mcp-server',
      risk: 'high',
      target: {
        serverName: 'example',
        transport: 'stdio',
        summary: 'npx -y @example/mcp',
      },
    });
    await harness.respond('allow-session');
    await expect(pending).resolves.toBeUndefined();

    await expect(findMcpServerGrant('example', server)).resolves.toMatchObject({
      serverName: 'example',
      scope: 'session',
    });
    await expect(assertMcpServerAllowedWithConfirmation({
      serverName: 'example',
      server,
      source: 'settings:mcp-enable',
    })).resolves.toBeUndefined();
    expect(harness.sent).toHaveLength(1);
  });

  it('allows file deletion inside authorized roots without confirmation or grants', async () => {
    const harness = setupConfirmationHarness();
    const root = await mkdtemp(join(tmpdir(), 'clawx-confirmation-file-'));
    const filePath = join(root, 'test.txt');
    await writeFile(filePath, 'hello', 'utf8');

    await expect(assertFileOperationAllowedWithConfirmation({
      path: filePath,
      capability: 'delete',
      allowedRoots: [root],
      source: 'agent',
    })).resolves.toMatchObject({
      decision: { action: 'allow' },
    });
    expect(harness.sent).toHaveLength(0);
    expect(await listAllPathGrants()).toHaveLength(0);
  });

  it('does not create a session grant for already-authorized file deletion', async () => {
    const harness = setupConfirmationHarness();
    const root = await mkdtemp(join(tmpdir(), 'clawx-confirmation-file-'));
    const filePath = join(root, 'delete-me.txt');
    await writeFile(filePath, 'temp', 'utf8');

    await assertFileOperationAllowedWithConfirmation({
      path: filePath,
      capability: 'delete',
      allowedRoots: [root],
      source: 'agent',
    });

    expect(harness.sent).toHaveLength(0);
    expect(await listAllPathGrants()).toHaveLength(0);
  });

  it('skips confirmation when a path grant already exists', async () => {
    const harness = setupConfirmationHarness();
    const root = await mkdtemp(join(tmpdir(), 'clawx-confirmation-file-'));
    const filePath = join(root, 'granted.txt');
    await writeFile(filePath, 'data', 'utf8');

    // Pre-create a grant
    await grantPathAccess(filePath, {
      capabilities: ['delete'],
      source: 'test:pre-grant',
    });

    const pending = assertFileOperationAllowedWithConfirmation({
      path: filePath,
      capability: 'delete',
      allowedRoots: [root],
      source: 'agent',
    });

    // Should resolve immediately without sending a confirmation request
    await expect(pending).resolves.toMatchObject({
      decision: { action: 'allow' },
    });
  });

  it('blocks file deletion outside authorized roots without asking for confirmation', async () => {
    const harness = setupConfirmationHarness();
    const root = await mkdtemp(join(tmpdir(), 'clawx-confirmation-file-'));
    const allowedRoot = await mkdtemp(join(tmpdir(), 'clawx-confirmation-allowed-'));
    const filePath = join(root, 'reject-me.txt');
    await writeFile(filePath, 'data', 'utf8');

    const pending = assertFileOperationAllowedWithConfirmation({
      path: filePath,
      capability: 'delete',
      allowedRoots: [allowedRoot],
      source: 'agent',
    });

    await expect(pending).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_AUTHORIZED_ROOTS',
    });
    expect(harness.sent).toHaveLength(0);
  });

  it('does not persist a grant for already-authorized file deletion', async () => {
    const harness = setupConfirmationHarness();
    const root = await mkdtemp(join(tmpdir(), 'clawx-confirmation-file-'));
    const filePath = join(root, 'persist-delete.txt');
    await writeFile(filePath, 'data', 'utf8');

    await assertFileOperationAllowedWithConfirmation({
      path: filePath,
      capability: 'delete',
      allowedRoots: [root],
      source: 'agent',
    });

    expect(harness.sent).toHaveLength(0);
    expect(await listAllPathGrants()).toHaveLength(0);
  });

  it('allows file read without confirmation when inside workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clawx-confirmation-file-'));
    const filePath = join(root, 'read-me.txt');
    await writeFile(filePath, 'data', 'utf8');

    // File read inside workspace should be allowed directly
    await expect(assertFileOperationAllowedWithConfirmation({
      path: filePath,
      capability: 'read',
      allowedRoots: [root],
      source: 'agent',
    })).resolves.toMatchObject({
      decision: { action: 'allow' },
    });
  });
});
