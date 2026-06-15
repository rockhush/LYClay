import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  grantCommandAccess,
  grantDomainAccess,
  grantMcpServerAccess,
  grantPathAccess,
  grantSkillAccess,
  resetPermissionStoreForTests,
} from '@electron/security/permission-store';
import {
  auditSecurityEvent,
  clearSecurityAuditEventsForTests,
} from '@electron/security/audit-log';

const sendJsonMock = vi.fn();
const parseJsonBodyMock = vi.fn();

vi.mock('@electron/api/route-utils', () => ({
  parseJsonBody: (...args: unknown[]) => parseJsonBodyMock(...args),
  sendJson: (...args: unknown[]) => sendJsonMock(...args),
}));

async function useTempPermissionFile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'clawx-security-routes-'));
  process.env.CLAWX_SECURITY_PERMISSIONS_PATH = join(root, 'security-permissions.json');
  process.env.CLAWX_SECURITY_AUDIT_LOG_PATH = join(root, 'audit-log.jsonl');
  resetPermissionStoreForTests();
  clearSecurityAuditEventsForTests();
  return root;
}

describe('handleSecurityRoutes', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    await useTempPermissionFile();
  });

  it('lists path, domain, and command grants', async () => {
    const root = await useTempPermissionFile();
    const filePath = join(root, 'workspace.txt');
    await writeFile(filePath, 'hello', 'utf8');
    await grantPathAccess(root, {
      capabilities: ['read'],
      recursive: true,
      source: 'dialog',
    });
    await grantDomainAccess('example.net', {
      source: 'settings:security',
    });
    await grantCommandAccess('npm install left-pad', {
      cwd: root,
      source: 'gateway:runtime-exec',
    });
    await grantSkillAccess('safe-skill', 'digest-v1', {
      filesystem: ['workspace:metadata', 'workspace:read', 'workspace:write'],
      network: [],
      commands: [],
      secrets: [],
    }, {
      source: 'skill:uploadZip',
    });

    const { handleSecurityRoutes } = await import('@electron/api/routes/security');
    const handled = await handleSecurityRoutes(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:13210/api/security/grants'),
      {} as never,
    );

    expect(handled).toBe(true);
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, {
      pathGrants: [expect.objectContaining({ path: root })],
      domainGrants: [expect.objectContaining({ domain: 'example.net' })],
      commandGrants: [expect.objectContaining({ command: 'npm install left-pad' })],
      mcpServerGrants: [],
      skillGrants: [expect.objectContaining({ skillId: 'safe-skill' })],
    });
  });

  it('creates persistent domain grants from settings', async () => {
    parseJsonBodyMock.mockResolvedValueOnce({
      domain: 'https://Allowed.EXAMPLE.net/',
      includeSubdomains: false,
      persistent: true,
    });
    const { handleSecurityRoutes } = await import('@electron/api/routes/security');

    const handled = await handleSecurityRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:13210/api/security/grants/domain'),
      {} as never,
    );

    expect(handled).toBe(true);
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, {
      success: true,
      grant: expect.objectContaining({
        domain: 'allowed.example.net',
        includeSubdomains: false,
        scope: 'persistent',
        source: 'settings:security',
      }),
    });
  });

  it('preflights low-risk runtime exec commands through command policy', async () => {
    parseJsonBodyMock.mockResolvedValueOnce({
      command: 'dir',
      agentId: 'main',
    });
    const { handleSecurityRoutes } = await import('@electron/api/routes/security');

    const handled = await handleSecurityRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:13210/api/security/command-policy/preflight'),
      {} as never,
    );

    expect(handled).toBe(true);
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, expect.objectContaining({
      success: true,
      result: expect.objectContaining({
        decision: expect.objectContaining({ action: 'allow' }),
      }),
    }));
  });

  it('rejects denied runtime exec commands during preflight', async () => {
    parseJsonBodyMock.mockResolvedValueOnce({
      command: 'powershell -EncodedCommand ZgBvAG8A',
      agentId: 'main',
    });
    const { handleSecurityRoutes } = await import('@electron/api/routes/security');

    const handled = await handleSecurityRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:13210/api/security/command-policy/preflight'),
      {} as never,
    );

    expect(handled).toBe(true);
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 403, expect.objectContaining({
      success: false,
      code: 'POWERSHELL_POLICY_BYPASS',
    }));
  });

  it('revokes domain grants by id', async () => {
    const grant = await grantDomainAccess('example.net', {
      persistent: true,
      source: 'settings:security',
    });
    const { handleSecurityRoutes } = await import('@electron/api/routes/security');

    const handled = await handleSecurityRoutes(
      { method: 'DELETE' } as IncomingMessage,
      {} as ServerResponse,
      new URL(`http://127.0.0.1:13210/api/security/grants/domain/${encodeURIComponent(grant.id)}`),
      {} as never,
    );

    expect(handled).toBe(true);
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, { success: true });
  });

  it('revokes path grants by id', async () => {
    const root = await useTempPermissionFile();
    const filePath = join(root, 'workspace.txt');
    await writeFile(filePath, 'hello', 'utf8');
    const grant = await grantPathAccess(root, {
      capabilities: ['read'],
      recursive: true,
      persistent: true,
      source: 'dialog',
    });
    const { handleSecurityRoutes } = await import('@electron/api/routes/security');

    const handled = await handleSecurityRoutes(
      { method: 'DELETE' } as IncomingMessage,
      {} as ServerResponse,
      new URL(`http://127.0.0.1:13210/api/security/grants/path/${encodeURIComponent(grant.id)}`),
      {} as never,
    );

    expect(handled).toBe(true);
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, { success: true });
  });

  it('revokes command grants by id', async () => {
    const grant = await grantCommandAccess('npm install left-pad', {
      persistent: true,
      source: 'gateway:runtime-exec',
    });
    const { handleSecurityRoutes } = await import('@electron/api/routes/security');

    const handled = await handleSecurityRoutes(
      { method: 'DELETE' } as IncomingMessage,
      {} as ServerResponse,
      new URL(`http://127.0.0.1:13210/api/security/grants/command/${encodeURIComponent(grant.id)}`),
      {} as never,
    );

    expect(handled).toBe(true);
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, { success: true });
  });

  it('revokes MCP server grants by id', async () => {
    const grant = await grantMcpServerAccess('example', {
      command: 'npx',
      args: ['-y', '@example/mcp'],
    }, {
      persistent: true,
      source: 'settings:mcp-enable',
    });
    const { handleSecurityRoutes } = await import('@electron/api/routes/security');

    const handled = await handleSecurityRoutes(
      { method: 'DELETE' } as IncomingMessage,
      {} as ServerResponse,
      new URL(`http://127.0.0.1:13210/api/security/grants/mcp-server/${encodeURIComponent(grant.id)}`),
      {} as never,
    );

    expect(handled).toBe(true);
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, { success: true });
  });

  it('revokes Skill grants by id', async () => {
    const grant = await grantSkillAccess('safe-skill', 'digest-v1', {
      filesystem: ['workspace:metadata', 'workspace:read', 'workspace:write'],
      network: [],
      commands: [],
      secrets: [],
    }, {
      source: 'skill:uploadZip',
    });
    const { handleSecurityRoutes } = await import('@electron/api/routes/security');

    const handled = await handleSecurityRoutes(
      { method: 'DELETE' } as IncomingMessage,
      {} as ServerResponse,
      new URL(`http://127.0.0.1:13210/api/security/grants/skill/${encodeURIComponent(grant.id)}`),
      {} as never,
    );

    expect(handled).toBe(true);
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, { success: true });
  });

  it('lists persisted audit events with filters', async () => {
    auditSecurityEvent({
      source: 'gateway:rpc',
      capability: 'network',
      operation: 'connect',
      target: 'https://example.net/',
      decision: 'prompt',
      risk: 'medium',
    });
    auditSecurityEvent({
      source: 'renderer:test',
      capability: 'command',
      operation: 'execute',
      target: 'npm install left-pad',
      decision: 'deny',
      risk: 'high',
      code: 'COMMAND_DENIED',
    });
    clearSecurityAuditEventsForTests();

    const { handleSecurityRoutes } = await import('@electron/api/routes/security');
    const handled = await handleSecurityRoutes(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:13210/api/security/audit-events?capability=command&decision=deny&limit=5'),
      {} as never,
    );

    expect(handled).toBe(true);
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, {
      success: true,
      events: [expect.objectContaining({
        capability: 'command',
        decision: 'deny',
        target: 'npm install left-pad',
      })],
    });
  });

  it('returns paginated audit events with totals', async () => {
    for (let index = 1; index <= 12; index += 1) {
      auditSecurityEvent({
        id: `route-page-${index}`,
        ts: index,
        source: 'route:pagination',
        capability: 'network',
        operation: 'connect',
        target: `https://example.test/${index}`,
        decision: 'allow',
        risk: 'low',
      });
    }

    const { handleSecurityRoutes } = await import('@electron/api/routes/security');
    const handled = await handleSecurityRoutes(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:13210/api/security/audit-events?page=2&pageSize=5&capability=network&source=route%3Apagination'),
      {} as never,
    );

    expect(handled).toBe(true);
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, expect.objectContaining({
      success: true,
      total: 12,
      page: 2,
      pageSize: 5,
      totalPages: 3,
      events: expect.arrayContaining([
        expect.objectContaining({ target: 'https://example.test/7' }),
      ]),
    }));
  });
});
