import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, describe, expect, it } from 'vitest';
import { evaluatePathPolicy } from '../../electron/security/path-policy';
import { clearSecurityAuditEventsForTests, querySecurityAuditEvents } from '../../electron/security/audit-log';
import {
  clearPersistentPathGrants,
  findDomainGrant,
  findMcpServerGrant,
  findSkillGrant,
  grantDomainAccess,
  grantPathAccess,
  grantMcpServerAccess,
  grantSkillAccess,
  listAllDomainGrants,
  listAllPathGrants,
  listAllMcpServerGrants,
  listAllSkillGrants,
  pruneExpiredPathGrants,
  resetPermissionStoreForTests,
  revokeDomainGrant,
  revokePathGrant,
  revokeMcpServerGrant,
  revokeSkillGrant,
  revokeSkillGrantsForSkill,
} from '../../electron/security/permission-store';

async function makeTempRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'clawx-permissions-'));
}

async function useTempPermissionFile(): Promise<string> {
  const root = await makeTempRoot();
  const filePath = join(root, 'security-permissions.json');
  process.env.CLAWX_SECURITY_PERMISSIONS_PATH = filePath;
  process.env.CLAWX_SECURITY_AUDIT_LOG_PATH = join(root, 'audit-log.jsonl');
  resetPermissionStoreForTests();
  clearSecurityAuditEventsForTests();
  return filePath;
}

describe('security permission store', () => {
  beforeEach(async () => {
    await useTempPermissionFile();
  });

  it('persists path grants and reloads them after cache reset', async () => {
    const root = await makeTempRoot();
    const filePath = join(root, 'workspace.txt');
    await writeFile(filePath, 'hello', 'utf8');

    const grant = await grantPathAccess(root, {
      capabilities: ['read'],
      recursive: true,
      persistent: true,
      source: 'settings:security',
    });

    expect(grant.scope).toBe('persistent');
    expect(await listAllPathGrants()).toHaveLength(1);

    resetPermissionStoreForTests();

    const reloaded = await listAllPathGrants();
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]?.id).toBe(grant.id);

    const result = await evaluatePathPolicy({
      path: filePath,
      capability: 'read',
      source: 'test',
    });
    expect(result.decision.action).toBe('allow');
  });

  it('revokes persistent grants and prevents future access', async () => {
    const root = await makeTempRoot();
    const filePath = join(root, 'workspace.txt');
    await writeFile(filePath, 'hello', 'utf8');

    const grant = await grantPathAccess(root, {
      capabilities: ['read'],
      recursive: true,
      persistent: true,
      source: 'settings:security',
    });

    expect(await revokePathGrant(grant.id)).toBe(true);
    resetPermissionStoreForTests();

    const result = await evaluatePathPolicy({
      path: filePath,
      capability: 'read',
      source: 'test',
    });

    expect(result.decision.action).toBe('deny');
  });

  it('prunes expired session and persistent grants', async () => {
    const sessionRoot = await makeTempRoot();
    const persistentRoot = await makeTempRoot();
    const server = { command: 'npx', args: ['-y', '@example/mcp'] };

    await grantPathAccess(sessionRoot, {
      capabilities: ['read'],
      recursive: true,
      ttlMs: -1,
      source: 'dialog:openDirectory',
    });
    await grantPathAccess(persistentRoot, {
      capabilities: ['read'],
      recursive: true,
      persistent: true,
      ttlMs: -1,
      source: 'settings:security',
    });
    await grantMcpServerAccess('session-example', server, {
      ttlMs: -1,
      source: 'settings:mcp-enable',
    });
    await grantMcpServerAccess('persistent-example', server, {
      persistent: true,
      ttlMs: -1,
      source: 'settings:mcp-enable',
    });

    const pruned = await pruneExpiredPathGrants();

    expect(pruned).toBe(4);
    expect(await listAllPathGrants()).toHaveLength(0);
    expect(await listAllMcpServerGrants()).toHaveLength(0);
  });

  it('keeps sensitive paths blocked even with an explicit persistent grant', async () => {
    const root = await makeTempRoot();
    const envPath = join(root, '.env.production');
    await writeFile(envPath, 'TOKEN=fake', 'utf8');

    await grantPathAccess(root, {
      capabilities: ['read'],
      recursive: true,
      persistent: true,
      source: 'settings:security',
    });

    const result = await evaluatePathPolicy({
      path: envPath,
      capability: 'read',
      source: 'test',
    });

    expect(result.decision.action).toBe('deny');
    expect(result.decision.action === 'deny' ? result.decision.code : '').toBe('SENSITIVE_PATH');
  });

  it('clears persistent grants without touching unrelated JSON shape', async () => {
    const permissionsFile = await useTempPermissionFile();
    const root = await makeTempRoot();

    await grantPathAccess(root, {
      capabilities: ['read'],
      recursive: true,
      persistent: true,
      source: 'settings:security',
    });

    await clearPersistentPathGrants();

    const raw = JSON.parse(await readFile(permissionsFile, 'utf8')) as { version?: number; pathGrants?: unknown[] };
    expect(raw.version).toBe(1);
    expect(raw.pathGrants).toEqual([]);
  });

  it('persists domain grants without overwriting path grants', async () => {
    const permissionsFile = await useTempPermissionFile();
    const root = await makeTempRoot();

    const pathGrant = await grantPathAccess(root, {
      capabilities: ['read'],
      recursive: true,
      persistent: true,
      source: 'settings:security',
    });
    const domainGrant = await grantDomainAccess('example.net', {
      persistent: true,
      source: 'security-confirmation',
    });

    resetPermissionStoreForTests();

    const pathGrants = await listAllPathGrants();
    const domainGrants = await listAllDomainGrants();
    const raw = JSON.parse(await readFile(permissionsFile, 'utf8')) as {
      version?: number;
      pathGrants?: unknown[];
      domainGrants?: unknown[];
    };

    expect(pathGrants[0]?.id).toBe(pathGrant.id);
    expect(domainGrants[0]?.id).toBe(domainGrant.id);
    expect(raw.pathGrants).toHaveLength(1);
    expect(raw.domainGrants).toHaveLength(1);
  });

  it('revokes domain grants and prevents future matches', async () => {
    const grant = await grantDomainAccess('example.net', {
      persistent: true,
      source: 'security-confirmation',
    });

    expect(await findDomainGrant('api.example.net')).not.toBeNull();
    expect(await revokeDomainGrant(grant.id)).toBe(true);
    resetPermissionStoreForTests();

    expect(await findDomainGrant('api.example.net')).toBeNull();
  });

  it('persists MCP server grants and invalidates them when security config changes', async () => {
    const server = { command: 'npx', args: ['-y', '@example/mcp'] };
    const grant = await grantMcpServerAccess('example', server, {
      persistent: true,
      source: 'settings:mcp-enable',
    });

    resetPermissionStoreForTests();

    expect(await listAllMcpServerGrants()).toHaveLength(1);
    expect(await findMcpServerGrant('example', server)).toMatchObject({ id: grant.id });
    expect(await findMcpServerGrant('example', { ...server, args: ['-y', '@example/mcp@2'] })).toBeNull();
    expect(await revokeMcpServerGrant(grant.id)).toBe(true);
    expect(await findMcpServerGrant('example', server)).toBeNull();
  });

  it('persists Skill grants and invalidates old grants when the manifest changes', async () => {
    const permissions = {
      filesystem: ['workspace:metadata', 'workspace:read', 'workspace:write'],
      network: ['api.example.com'],
      commands: ['python'],
      secrets: [],
    };
    const first = await grantSkillAccess('safe-skill', 'digest-v1', permissions, {
      source: 'skill:uploadZip',
    });

    resetPermissionStoreForTests();

    expect(await findSkillGrant('safe-skill', 'digest-v1')).toMatchObject({ id: first.id });
    const second = await grantSkillAccess('safe-skill', 'digest-v2', permissions, {
      source: 'skill:uploadZip',
    });

    expect(await findSkillGrant('safe-skill', 'digest-v1')).toBeNull();
    expect(await findSkillGrant('safe-skill', 'digest-v2')).toMatchObject({ id: second.id });
    expect(await listAllSkillGrants()).toHaveLength(1);
    expect(querySecurityAuditEvents({ decision: 'invalidate' })).toEqual([
      expect.objectContaining({
        capability: 'permission',
        operation: 'invalidate:skill',
        target: 'safe-skill',
      }),
    ]);
  });

  it('revokes Skill grants explicitly', async () => {
    const grant = await grantSkillAccess('safe-skill', 'digest-v1', {
      filesystem: ['workspace:metadata', 'workspace:read', 'workspace:write'],
      network: [],
      commands: [],
      secrets: [],
    }, {
      source: 'skill:uploadZip',
    });

    expect(await revokeSkillGrant(grant.id)).toBe(true);
    expect(await findSkillGrant('safe-skill', 'digest-v1')).toBeNull();
  });

  it('revokes active Skill grants when a Skill is uninstalled', async () => {
    await grantSkillAccess('safe-skill', 'digest-v1', {
      filesystem: ['workspace:metadata', 'workspace:read', 'workspace:write'],
      network: [],
      commands: [],
      secrets: [],
    }, {
      source: 'skill:uploadZip',
    });

    expect(await revokeSkillGrantsForSkill('safe-skill')).toBe(1);
    expect(await listAllSkillGrants()).toEqual([]);
  });
});
