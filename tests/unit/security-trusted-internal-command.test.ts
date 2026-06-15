import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearSecurityAuditEventsForTests, listSecurityAuditEvents } from '@electron/security/audit-log';
import { assertTrustedInternalCommand } from '@electron/security/trusted-internal-command';

let auditDir: string | null = null;
const originalAuditPath = process.env.CLAWX_SECURITY_AUDIT_LOG_PATH;

describe('trusted internal command boundary', () => {
  beforeEach(async () => {
    clearSecurityAuditEventsForTests();
    auditDir = await mkdtemp(path.join(tmpdir(), 'clawx-internal-command-audit-'));
    process.env.CLAWX_SECURITY_AUDIT_LOG_PATH = path.join(auditDir, 'audit.jsonl');
  });

  afterEach(async () => {
    clearSecurityAuditEventsForTests();
    if (originalAuditPath == null) {
      delete process.env.CLAWX_SECURITY_AUDIT_LOG_PATH;
    } else {
      process.env.CLAWX_SECURITY_AUDIT_LOG_PATH = originalAuditPath;
    }
    if (auditDir) {
      await rm(auditDir, { recursive: true, force: true });
      auditDir = null;
    }
  });

  it('allows fixed Gateway launch commands and writes an internal-command audit event', () => {
    assertTrustedInternalCommand({
      operation: 'gateway:launch',
      executable: 'D:/code/ClawX/node_modules/openclaw/openclaw.mjs',
      args: ['gateway', '--port', '18789', '--token', 'secret-token'],
      cwd: 'D:/code/ClawX/node_modules/openclaw',
      source: 'system:test',
    });

    expect(listSecurityAuditEvents()).toContainEqual(expect.objectContaining({
      capability: 'internal-command',
      operation: 'gateway:launch',
      decision: 'allow',
      source: 'system:test',
    }));
  });

  it('rejects malformed Gateway launch commands before the process can start', () => {
    expect(() => assertTrustedInternalCommand({
      operation: 'gateway:launch',
      executable: 'D:/code/ClawX/node_modules/openclaw/openclaw.mjs',
      args: ['doctor', '--fix'],
    })).toThrow('Gateway launch must use the bundled entry script and a numeric port');

    expect(listSecurityAuditEvents()).toContainEqual(expect.objectContaining({
      capability: 'internal-command',
      operation: 'gateway:launch',
      decision: 'deny',
      code: 'UNTRUSTED_INTERNAL_COMMAND',
    }));
  });

  it('only allows listener queries by numeric port', () => {
    assertTrustedInternalCommand({
      operation: 'gateway:listener-query',
      executable: 'netstat.exe',
      args: ['18789'],
    });

    expect(() => assertTrustedInternalCommand({
      operation: 'gateway:listener-query',
      executable: 'netstat.exe',
      args: ['18789', '|', 'calc.exe'],
    })).toThrow('Gateway listener query only accepts the port argument');
  });

  it('only allows process-tree cleanup by numeric PID', () => {
    assertTrustedInternalCommand({
      operation: 'gateway:process-tree-kill',
      executable: 'taskkill',
      args: ['/F', '/PID', '4321', '/T'],
    });

    expect(() => assertTrustedInternalCommand({
      operation: 'gateway:process-tree-kill',
      executable: 'taskkill',
      args: ['/F', '/PID', 'not-a-pid', '/T'],
    })).toThrow('Gateway process-tree cleanup requires a numeric PID');
  });
});
