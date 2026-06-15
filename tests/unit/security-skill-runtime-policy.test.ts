import crypto from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearSecurityAuditEventsForTests, querySecurityAuditEvents } from '@electron/security/audit-log';
import { grantSkillAccess, resetPermissionStoreForTests, revokeSkillGrant } from '@electron/security/permission-store';
import {
  evaluateSkillRuntimeCommandPolicy,
  evaluateSkillRuntimeDeclaration,
  evaluateSkillRuntimeFilePolicy,
  evaluateSkillRuntimeNetworkPolicy,
} from '@electron/security/skill-runtime-policy';

async function setup(): Promise<{ root: string; context: { skillId: string; manifestDigest: string } }> {
  const root = await mkdtemp(join(tmpdir(), 'clawx-skill-runtime-'));
  process.env.CLAWX_SECURITY_PERMISSIONS_PATH = join(root, 'security-permissions.json');
  process.env.CLAWX_SECURITY_AUDIT_LOG_PATH = join(root, 'audit-log.jsonl');
  process.env.CLAWX_LEGACY_SKILLS_ROOT = join(root, 'skills');
  resetPermissionStoreForTests();
  clearSecurityAuditEventsForTests();
  await grantSkillAccess('safe-skill', 'digest-v1', {
    filesystem: ['workspace:metadata', 'workspace:read', 'workspace:write'],
    network: ['api.example.com'],
    commands: ['node'],
    secrets: [],
  }, {
    source: 'test',
  });
  return { root, context: { skillId: 'safe-skill', manifestDigest: 'digest-v1' } };
}

describe('Skill runtime policy', () => {
  beforeEach(() => {
    delete process.env.CLAWX_LEGACY_SKILLS_ROOT;
    resetPermissionStoreForTests();
    clearSecurityAuditEventsForTests();
  });

  it('allows declared Workspace reads and still delegates to path policy', async () => {
    const { root, context } = await setup();
    const filePath = join(root, 'README.md');
    await writeFile(filePath, 'hello', 'utf8');

    const result = await evaluateSkillRuntimeFilePolicy({
      kind: 'file',
      context,
      path: filePath,
      capability: 'read',
      allowedRoots: [root],
    });

    expect(result.decision.action).toBe('allow');
  });

  it('denies undeclared file capabilities before path policy can allow them', async () => {
    const { root, context } = await setup();
    const filePath = join(root, 'README.md');
    await writeFile(filePath, 'hello', 'utf8');

    const result = await evaluateSkillRuntimeDeclaration({
      kind: 'file',
      context,
      path: filePath,
      capability: 'delete',
    });

    expect(result.decision).toMatchObject({
      action: 'deny',
      code: 'SKILL_FILESYSTEM_PERMISSION_NOT_DECLARED',
    });
  });

  it('does not bypass sensitive path rules when a Workspace read was declared', async () => {
    const { root, context } = await setup();
    const filePath = join(root, '.env');
    await writeFile(filePath, 'TOKEN=secret', 'utf8');

    const result = await evaluateSkillRuntimeFilePolicy({
      kind: 'file',
      context,
      path: filePath,
      capability: 'read',
      allowedRoots: [root],
    });

    expect(result.decision.action).toBe('deny');
  });

  it('allows declared domains but denies undeclared domains', async () => {
    const { context } = await setup();

    await expect(evaluateSkillRuntimeNetworkPolicy({
      kind: 'network',
      context,
      url: 'https://api.example.com/data',
    })).resolves.toMatchObject({
      decision: { action: 'allow' },
    });

    await expect(evaluateSkillRuntimeNetworkPolicy({
      kind: 'network',
      context,
      url: 'https://upload.example.org/data',
    })).resolves.toMatchObject({
      decision: {
        action: 'deny',
        code: 'SKILL_NETWORK_PERMISSION_NOT_DECLARED',
      },
    });
  });

  it('delegates declared and undeclared Skill command launchers to command policy', async () => {
    const { root, context } = await setup();

    await expect(evaluateSkillRuntimeCommandPolicy({
      kind: 'command',
      context,
      command: 'node --version',
      cwd: root,
      allowedRoots: [root],
    })).resolves.toMatchObject({
      decision: { action: 'allow' },
    });

    await expect(evaluateSkillRuntimeCommandPolicy({
      kind: 'command',
      context,
      command: 'ruby script.rb',
      cwd: root,
      allowedRoots: [root],
    })).resolves.toMatchObject({
      decision: { action: 'allow' },
    });

    await expect(evaluateSkillRuntimeCommandPolicy({
      kind: 'command',
      context,
      command: 'node --version && powershell -Command Get-Date',
      cwd: root,
      allowedRoots: [root],
    })).resolves.toMatchObject({
      decision: { action: 'allow' },
    });

    await expect(evaluateSkillRuntimeCommandPolicy({
      kind: 'command',
      context,
      command: 'dir "scripts"',
      cwd: root,
      allowedRoots: [root],
    })).resolves.toMatchObject({
      decision: { action: 'allow' },
    });
  });

  it('allows standard script launchers (uv/python) even when not declared by the Skill', async () => {
    const { root, context } = await setup();

    // The grant only declares 'node', not 'uv' — but uv/python are default-allowed launchers.
    await expect(evaluateSkillRuntimeCommandPolicy({
      kind: 'command',
      context,
      command: 'uv run --with requests python script.py --query-word 11427192',
      cwd: root,
      allowedRoots: [root],
    })).resolves.toMatchObject({
      decision: { action: 'allow' },
    });
  });

  it('auto-allows routine prompt-level command checks for declared Skill commands', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clawx-skill-runtime-routine-'));
    process.env.CLAWX_SECURITY_PERMISSIONS_PATH = join(root, 'security-permissions.json');
    process.env.CLAWX_SECURITY_AUDIT_LOG_PATH = join(root, 'audit-log.jsonl');
    resetPermissionStoreForTests();
    clearSecurityAuditEventsForTests();
    await grantSkillAccess('ppt-master', 'digest-v1', {
      filesystem: ['workspace:metadata', 'workspace:read', 'workspace:write'],
      network: [],
      commands: ['uv'],
      secrets: [],
    }, { source: 'test' });

    const result = await evaluateSkillRuntimeCommandPolicy({
      kind: 'command',
      context: { skillId: 'ppt-master', manifestDigest: 'digest-v1' },
      command: 'uv run python project_manager.py init shenzhen_intro --format ppt169 > project.log',
      cwd: root,
      allowedRoots: [root],
    });

    expect(result.decision).toMatchObject({
      action: 'allow',
      risk: 'medium',
    });
    expect(result.delegatedResult?.segments.some((segment) => segment.matchedRules.includes('command-path-write'))).toBe(true);
  });

  it('treats the Skill own directory as cwd-authorized without explicit allowedRoots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clawx-skill-runtime-cwd-'));
    process.env.CLAWX_SECURITY_PERMISSIONS_PATH = join(root, 'security-permissions.json');
    process.env.CLAWX_SECURITY_AUDIT_LOG_PATH = join(root, 'audit-log.jsonl');
    process.env.CLAWX_LEGACY_SKILLS_ROOT = join(root, 'skills');
    resetPermissionStoreForTests();
    clearSecurityAuditEventsForTests();
    await grantSkillAccess('dingtalk-calendar', 'digest-v1', {
      filesystem: ['workspace:metadata', 'workspace:read'],
      network: [],
      commands: ['uv'],
      secrets: [],
    }, { source: 'test' });

    // The Skill's own directory must exist so path-policy can realpath it.
    const skillDir = join(root, 'skills', 'dingtalk-calendar');
    await mkdir(join(skillDir, 'scripts'), { recursive: true });
    const scriptPath = join(skillDir, 'scripts', 'query_event.py');
    await writeFile(scriptPath, 'print("ok")', 'utf8');

    // No allowedRoots passed — mirrors the gateway exec bridge calling the policy.
    const result = await evaluateSkillRuntimeCommandPolicy({
      kind: 'command',
      context: { skillId: 'dingtalk-calendar', manifestDigest: 'digest-v1' },
      command: `uv run --with requests python "${scriptPath}" --query-word "11427192" --max-results 10`,
      cwd: skillDir,
    });

    expect(result.decision.action).not.toBe('deny');
    expect(result.delegatedResult?.segments.some((segment) => segment.code === 'PATH_OUTSIDE_AUTHORIZED_ROOTS')).toBeFalsy();
  });

  it('keeps high-risk declared Skill command prompts from being auto-allowed', async () => {
    const { root } = await setup();
    await grantSkillAccess('danger-skill', 'digest-v1', {
      filesystem: ['workspace:metadata', 'workspace:read', 'workspace:write'],
      network: [],
      commands: ['npx'],
      secrets: [],
    }, { source: 'test' });

    const result = await evaluateSkillRuntimeCommandPolicy({
      kind: 'command',
      context: { skillId: 'danger-skill', manifestDigest: 'digest-v1' },
      command: 'npx remote-package',
      cwd: root,
      allowedRoots: [root],
    });

    expect(result.decision).toMatchObject({
      action: 'prompt',
      risk: 'high',
    });
  });

  it('denies revoked grants and records Skill runtime audit events', async () => {
    const { context } = await setup();
    const grant = await grantSkillAccess('safe-skill', 'digest-v1', {
      filesystem: ['workspace:metadata', 'workspace:read', 'workspace:write'],
      network: ['api.example.com'],
      commands: ['node'],
      secrets: [],
    });
    await revokeSkillGrant(grant.id);

    const result = await evaluateSkillRuntimeDeclaration({
      kind: 'network',
      context,
      url: 'https://api.example.com/data',
    });

    expect(result.decision).toMatchObject({
      action: 'deny',
      code: 'SKILL_RUNTIME_GRANT_REQUIRED',
    });
    expect(querySecurityAuditEvents({ capability: 'skill-runtime' })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subject: 'skill:safe-skill',
          decision: 'deny',
          code: 'SKILL_RUNTIME_GRANT_REQUIRED',
        }),
      ]),
    );
  });

  it('allows legacy local skills without a stored grant when the manifest digest matches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clawx-skill-runtime-legacy-'));
    process.env.CLAWX_SECURITY_PERMISSIONS_PATH = join(root, 'security-permissions.json');
    process.env.CLAWX_SECURITY_AUDIT_LOG_PATH = join(root, 'audit-log.jsonl');
    process.env.CLAWX_LEGACY_SKILLS_ROOT = join(root, 'skills');
    resetPermissionStoreForTests();
    clearSecurityAuditEventsForTests();

    const manifest = [
      '---',
      'name: dws',
      'description: DingTalk work schedule.',
      '---',
      '',
      '# DWS',
    ].join('\n');
    const skillDir = join(process.env.CLAWX_LEGACY_SKILLS_ROOT, 'dws');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), manifest, 'utf8');
    const manifestDigest = crypto.createHash('sha256').update(manifest).digest('hex');

    const result = await evaluateSkillRuntimeCommandPolicy({
      kind: 'command',
      context: {
        skillId: 'dws',
        manifestDigest,
      },
      command: 'python --version',
      cwd: root,
      allowedRoots: [root],
    });

    expect(result.legacyLocalSkill).toBe(true);
    expect(result.decision.action).not.toBe('deny');
    expect(querySecurityAuditEvents({ capability: 'skill-runtime' })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subject: 'skill:dws',
          decision: 'allow',
        }),
      ]),
    );
  });
});
