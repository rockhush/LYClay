import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearSecurityAuditEventsForTests,
  querySecurityAuditEvents,
} from '@electron/security/audit-log';
import { resetPermissionStoreForTests } from '@electron/security/permission-store';
import { secureProxyAwareFetch } from '@electron/security/network-fetch';

const proxyAwareFetchMock = vi.fn();

vi.mock('@electron/utils/proxy-fetch', () => ({
  proxyAwareFetch: (...args: unknown[]) => proxyAwareFetchMock(...args),
}));

function response(status: number, headers: Record<string, string> = {}, body = 'ok'): Response {
  return new Response(body, { status, headers });
}

async function resetSecurityState(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'clawx-network-fetch-'));
  process.env.CLAWX_SECURITY_PERMISSIONS_PATH = join(root, 'security-permissions.json');
  process.env.CLAWX_SECURITY_AUDIT_LOG_PATH = join(root, 'audit-log.jsonl');
  resetPermissionStoreForTests();
  clearSecurityAuditEventsForTests();
  proxyAwareFetchMock.mockReset();
}

describe('secureProxyAwareFetch', () => {
  beforeEach(async () => {
    await resetSecurityState();
  });

  it('allows same-origin relative redirects after policy checks', async () => {
    proxyAwareFetchMock
      .mockResolvedValueOnce(response(302, { location: '/next' }))
      .mockResolvedValueOnce(response(200));

    const result = await secureProxyAwareFetch(
      'http://127.0.0.1:18789/start',
      { method: 'GET' },
      { source: 'test:gateway', allowLocalhostPorts: [18789] },
    );

    expect(result.status).toBe(200);
    expect(proxyAwareFetchMock).toHaveBeenNthCalledWith(1, 'http://127.0.0.1:18789/start', expect.objectContaining({
      redirect: 'manual',
    }));
    expect(proxyAwareFetchMock).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:18789/next', expect.objectContaining({
      redirect: 'manual',
    }));
  });

  it('does not audit low-risk allowlisted Host API requests from the renderer', async () => {
    proxyAwareFetchMock.mockResolvedValueOnce(response(200));

    await expect(secureProxyAwareFetch(
      'http://127.0.0.1:13210/api/agents',
      { method: 'GET' },
      { source: 'renderer:hostapi-fetch', allowLocalhostPorts: [13210] },
    )).resolves.toMatchObject({ status: 200 });

    expect(querySecurityAuditEvents({ capability: 'network', limit: 10 })).toEqual([]);
  });

  it('continues auditing allowlisted localhost requests from other sources', async () => {
    proxyAwareFetchMock.mockResolvedValueOnce(response(200));

    await expect(secureProxyAwareFetch(
      'http://127.0.0.1:13210/api/agents',
      { method: 'GET' },
      { source: 'test:hostapi', allowLocalhostPorts: [13210] },
    )).resolves.toMatchObject({ status: 200 });

    expect(querySecurityAuditEvents({ capability: 'network', limit: 10 })).toEqual([
      expect.objectContaining({
        source: 'test:hostapi',
        target: 'http://127.0.0.1:13210/api/agents',
        decision: 'allow',
        risk: 'low',
      }),
    ]);
  });

  it('allows redirects to built-in allowed public domains', async () => {
    proxyAwareFetchMock
      .mockResolvedValueOnce(response(302, { location: 'https://github.com/openai/codex' }))
      .mockResolvedValueOnce(response(200));

    await expect(secureProxyAwareFetch(
      'http://127.0.0.1:18789/start',
      { method: 'GET' },
      { source: 'test:gateway', allowLocalhostPorts: [18789] },
    )).resolves.toMatchObject({ status: 200 });

    const auditEvents = querySecurityAuditEvents({ capability: 'network', limit: 10 })
      .filter((event) => event.operation === 'redirect');
    expect(auditEvents).toEqual([
      expect.objectContaining({
        operation: 'redirect',
        target: 'https://github.com/openai/codex',
        decision: 'allow',
      }),
    ]);
  });

  it('blocks redirects to unknown public domains', async () => {
    proxyAwareFetchMock.mockResolvedValueOnce(response(302, {
      location: 'https://unreviewed.example.net/collect',
    }));

    await expect(secureProxyAwareFetch(
      'http://127.0.0.1:18789/start',
      { method: 'GET' },
      { source: 'test:gateway', allowLocalhostPorts: [18789] },
    )).rejects.toMatchObject({
      code: 'NETWORK_REQUIRES_CONFIRMATION',
    });

    expect(proxyAwareFetchMock).toHaveBeenCalledTimes(1);
    const auditEvents = querySecurityAuditEvents({ capability: 'network', limit: 10 })
      .filter((event) => event.operation === 'redirect');
    expect(auditEvents).toEqual([
      expect.objectContaining({
        operation: 'redirect',
        target: 'https://unreviewed.example.net/collect',
        decision: 'prompt',
      }),
    ]);
  });

  it('blocks redirects to metadata and private addresses', async () => {
    proxyAwareFetchMock.mockResolvedValueOnce(response(302, {
      location: 'http://169.254.169.254/latest/meta-data/',
    }));

    await expect(secureProxyAwareFetch(
      'http://127.0.0.1:18789/start',
      { method: 'GET' },
      { source: 'test:gateway', allowLocalhostPorts: [18789] },
    )).rejects.toMatchObject({
      code: 'NETWORK_PRIVATE_ADDRESS_BLOCKED',
    });

    const auditEvents = querySecurityAuditEvents({ capability: 'network', limit: 10 })
      .filter((event) => event.operation === 'redirect');
    expect(auditEvents).toEqual([
      expect.objectContaining({
        operation: 'redirect',
        target: 'http://169.254.169.254/latest/meta-data/',
        decision: 'deny',
      }),
    ]);
  });
});
