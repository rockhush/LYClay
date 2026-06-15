import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, describe, expect, it } from 'vitest';
import { validateMcpConfig, validateMcpConfigNetworkPolicy } from '../../electron/utils/mcp-config-validator';
import {
  grantDomainAccess,
  resetPermissionStoreForTests,
} from '../../electron/security/permission-store';
import { clearSecurityAuditEventsForTests, querySecurityAuditEvents } from '../../electron/security/audit-log';

async function useTempSecurityStores(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'clawx-mcp-config-security-'));
  process.env.CLAWX_SECURITY_PERMISSIONS_PATH = join(root, 'security-permissions.json');
  process.env.CLAWX_SECURITY_AUDIT_LOG_PATH = join(root, 'audit-log.jsonl');
  resetPermissionStoreForTests();
  clearSecurityAuditEventsForTests();
}

describe('validateMcpConfig', () => {
  beforeEach(async () => {
    await useTempSecurityStores();
  });

  it('accepts empty servers', () => {
    const r = validateMcpConfig({ servers: {} });
    expect(r.valid).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it('accepts stdio npx github template', () => {
    const r = validateMcpConfig({
      servers: {
        github: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_test' },
          disabled: false,
        },
      },
    });
    expect(r.valid).toBe(true);
  });

  it('accepts http url for streamable-http', () => {
    const r = validateMcpConfig({
      servers: {
        x: { type: 'streamable-http', url: 'http://example.com', disabled: false },
      },
    });
    expect(r.valid).toBe(true);
  });

  it('accepts secure websocket urls structurally', () => {
    const r = validateMcpConfig({
      servers: {
        x: { type: 'streamable-http', url: 'wss://example.com/mcp', disabled: false },
      },
    });
    expect(r.valid).toBe(true);
  });

  it('rejects suspicious stdio command', () => {
    const r = validateMcpConfig({
      servers: {
        x: { type: 'stdio', command: 'curl;rm -rf /', disabled: false },
      },
    });
    expect(r.valid).toBe(false);
  });

  it('accepts tools.allow / tools.deny as non-empty string arrays', () => {
    const r = validateMcpConfig({
      servers: {
        x: {
          type: 'streamable-http',
          url: 'https://example.com/mcp',
          disabled: false,
          tools: { allow: ['tool_a'], deny: ['tool_b'] },
        },
      },
    });
    expect(r.valid).toBe(true);
  });

  it('rejects empty tools.deny array', () => {
    const r = validateMcpConfig({
      servers: {
        x: {
          type: 'streamable-http',
          url: 'https://example.com/mcp',
          disabled: false,
          tools: { deny: [] },
        },
      },
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('tools.deny'))).toBe(true);
  });

  it('allows remote MCP URLs after a domain grant and audits the network decision', async () => {
    await grantDomainAccess('example.com', {
      source: 'settings:security',
    });

    const r = await validateMcpConfigNetworkPolicy({
      servers: {
        docs: {
          type: 'streamable-http',
          url: 'https://example.com/mcp',
          disabled: false,
        },
      },
    });

    expect(r.valid).toBe(true);
    expect(querySecurityAuditEvents({ capability: 'network', limit: 10 })).toEqual([
      expect.objectContaining({
        source: 'settings:mcp-config',
        target: 'https://example.com/mcp',
        decision: 'allow',
      }),
    ]);
  });

  it('rejects unknown remote MCP domains during network preflight', async () => {
    const r = await validateMcpConfigNetworkPolicy({
      servers: {
        docs: {
          type: 'streamable-http',
          url: 'https://unreviewed.example.net/mcp',
          disabled: false,
        },
      },
    });

    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('unreviewed.example.net'))).toBe(true);
  });

  it('rejects metadata endpoints during remote MCP network preflight', async () => {
    const r = await validateMcpConfigNetworkPolicy({
      servers: {
        metadata: {
          type: 'streamable-http',
          url: 'https://169.254.169.254/latest/meta-data',
          disabled: false,
        },
      },
    });

    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('metadata') || e.includes('Link-local'))).toBe(true);
  });
});
