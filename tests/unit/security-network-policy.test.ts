import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  assertNetworkAllowed,
  evaluateNetworkPolicy,
} from '@electron/security/network-policy';
import {
  grantDomainAccess,
  pruneExpiredPathGrants,
  resetPermissionStoreForTests,
  revokeDomainGrant,
} from '@electron/security/permission-store';

async function useTempPermissionFile(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'clawx-network-permissions-'));
  process.env.CLAWX_SECURITY_PERMISSIONS_PATH = join(root, 'security-permissions.json');
  resetPermissionStoreForTests();
}

describe('network security policy', () => {
  beforeEach(async () => {
    await useTempPermissionFile();
  });

  it('allows an explicitly allowlisted https domain', async () => {
    const result = await evaluateNetworkPolicy({
      url: 'https://api.openai.com/v1/models',
      source: 'agent',
    });

    expect(result.decision.action).toBe('allow');
    expect(result.matchedRule).toBe('domain-allowlist');
  });

  it('normalizes uppercase scheme and host before allowlist matching', async () => {
    const result = await evaluateNetworkPolicy({
      url: 'HTTPS://API.OPENAI.COM:443/v1/models',
      source: 'agent',
    });

    expect(result.decision.action).toBe('allow');
    expect(result.hostname).toBe('api.openai.com');
  });

  it('allows subdomains of a caller-provided allowlist domain', async () => {
    const result = await evaluateNetworkPolicy({
      url: 'https://assets.example.com/file.json',
      allowedDomains: ['example.com'],
      source: 'plugin',
    });

    expect(result.decision.action).toBe('allow');
  });

  it('does not allow lookalike domains that merely contain an allowlisted suffix', async () => {
    const result = await evaluateNetworkPolicy({
      url: 'https://api.openai.com.evil.example/data',
      source: 'agent',
    });

    expect(result.decision.action).toBe('prompt');
    expect(result.matchedRule).toBe('unknown-public-domain');
  });

  it('returns prompt for unknown public domains', async () => {
    const result = await evaluateNetworkPolicy({
      url: 'https://unreviewed.example.net/data',
      source: 'skill',
    });

    expect(result.decision.action).toBe('prompt');
    expect(result.matchedRule).toBe('unknown-public-domain');
  });

  it('allows ordinary HTTPS public reads without storing a domain grant', async () => {
    const result = await evaluateNetworkPolicy({
      url: 'https://docs.example.net/guide?lang=zh-CN',
      source: 'agent',
      intent: 'public-read',
      method: 'GET',
    });

    expect(result.decision.action).toBe('allow');
    expect(result.matchedRule).toBe('public-https-read');
  });

  it('requires confirmation for suspicious public read targets', async () => {
    const insecureHttp = await evaluateNetworkPolicy({
      url: 'http://docs.example.net/guide',
      source: 'agent',
      intent: 'public-read',
      method: 'GET',
    });
    const shortUrl = await evaluateNetworkPolicy({
      url: 'https://bit.ly/example',
      source: 'agent',
      intent: 'public-read',
      method: 'GET',
    });
    const nonDefaultPort = await evaluateNetworkPolicy({
      url: 'https://docs.example.net:8443/guide',
      source: 'agent',
      intent: 'public-read',
      method: 'GET',
    });
    const rawIp = await evaluateNetworkPolicy({
      url: 'https://8.8.8.8/guide',
      source: 'agent',
      intent: 'public-read',
      method: 'GET',
    });

    expect(insecureHttp.matchedRule).toBe('public-read-insecure-http');
    expect(shortUrl.matchedRule).toBe('public-read-short-url');
    expect(nonDefaultPort.matchedRule).toBe('public-read-non-default-port');
    expect(rawIp.matchedRule).toBe('public-read-ip-address');
    expect([
      insecureHttp.decision.action,
      shortUrl.decision.action,
      nonDefaultPort.decision.action,
      rawIp.decision.action,
    ]).toEqual(['prompt', 'prompt', 'prompt', 'prompt']);
  });

  it('requires confirmation before downloading executable content', async () => {
    const result = await evaluateNetworkPolicy({
      url: 'https://downloads.example.net/setup.exe',
      source: 'agent',
      intent: 'public-read',
      method: 'GET',
    });

    expect(result.decision.action).toBe('prompt');
    expect(result.matchedRule).toBe('dangerous-download');
  });

  it('blocks secrets in outbound public requests', async () => {
    const querySecret = await evaluateNetworkPolicy({
      url: 'https://upload.example.net/collect?token=sk-abcdefghijklmnopqrstuvwxyz123456',
      source: 'agent',
      intent: 'send-data',
      method: 'POST',
    });
    const headerSecret = await evaluateNetworkPolicy({
      url: 'https://upload.example.net/collect',
      source: 'agent',
      intent: 'send-data',
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-abcdefghijklmnopqrstuvwxyz123456',
      },
    });

    expect(querySecret.decision.action).toBe('deny');
    expect(querySecret.matchedRule).toBe('outbound-secret');
    expect(headerSecret.decision.action).toBe('deny');
    expect(headerSecret.matchedRule).toBe('outbound-secret');
  });

  it('allows unknown public domains after a session domain grant', async () => {
    await grantDomainAccess('unreviewed.example.net', {
      source: 'security-confirmation',
    });

    const result = await evaluateNetworkPolicy({
      url: 'https://unreviewed.example.net/data',
      source: 'agent',
    });

    expect(result.decision.action).toBe('allow');
    expect(result.matchedRule).toBe('domain-grant');
  });

  it('normalizes full URL values when creating domain grants', async () => {
    const grant = await grantDomainAccess('https://www.baidu.com/', {
      source: 'settings:security',
    });

    const result = await evaluateNetworkPolicy({
      url: 'https://www.baidu.com/',
      source: 'agent',
    });

    expect(grant.domain).toBe('www.baidu.com');
    expect(result.decision.action).toBe('allow');
    expect(result.matchedRule).toBe('domain-grant');
  });

  it('keeps exact-domain grants from automatically allowing subdomains', async () => {
    await grantDomainAccess('narrow.example.net', {
      includeSubdomains: false,
      source: 'security-confirmation',
    });

    const exact = await evaluateNetworkPolicy({
      url: 'https://narrow.example.net/data',
      source: 'agent',
    });
    const subdomain = await evaluateNetworkPolicy({
      url: 'https://api.narrow.example.net/data',
      source: 'agent',
    });

    expect(exact.decision.action).toBe('allow');
    expect(exact.matchedRule).toBe('domain-grant');
    expect(subdomain.decision.action).toBe('prompt');
    expect(subdomain.matchedRule).toBe('unknown-public-domain');
  });

  it('persists domain grants across permission store reloads', async () => {
    const grant = await grantDomainAccess('example.net', {
      persistent: true,
      source: 'settings:security',
    });
    resetPermissionStoreForTests();

    const result = await evaluateNetworkPolicy({
      url: 'https://api.example.net/data',
      source: 'plugin',
    });

    expect(grant.scope).toBe('persistent');
    expect(result.decision.action).toBe('allow');
    expect(result.matchedRule).toBe('domain-grant');
  });

  it('returns prompt again after a domain grant is revoked', async () => {
    const grant = await grantDomainAccess('example.net', {
      persistent: true,
      source: 'settings:security',
    });
    expect(await revokeDomainGrant(grant.id)).toBe(true);
    resetPermissionStoreForTests();

    const result = await evaluateNetworkPolicy({
      url: 'https://example.net/data',
      source: 'plugin',
    });

    expect(result.decision.action).toBe('prompt');
  });

  it('does not use expired domain grants', async () => {
    await grantDomainAccess('expired.example.net', {
      ttlMs: -1,
      source: 'security-confirmation',
    });
    expect(await pruneExpiredPathGrants()).toBe(1);

    const result = await evaluateNetworkPolicy({
      url: 'https://expired.example.net/data',
      source: 'agent',
    });

    expect(result.decision.action).toBe('prompt');
  });

  it('blocks unsupported protocols', async () => {
    const result = await evaluateNetworkPolicy({
      url: 'file:///C:/Users/Leon/.ssh/id_rsa',
      source: 'agent',
    });

    expect(result.decision.action).toBe('deny');
    expect(result.decision.action === 'deny' ? result.decision.code : '').toBe('NETWORK_PROTOCOL_BLOCKED');
  });

  it('routes websocket protocols through network policy', async () => {
    const ws = await evaluateNetworkPolicy({ url: 'ws://api.openai.com/realtime', source: 'agent' });
    const wss = await evaluateNetworkPolicy({ url: 'wss://api.openai.com/realtime', source: 'agent' });

    expect(ws.decision.action).toBe('prompt');
    expect(ws.matchedRule).toBe('insecure-websocket');
    expect(wss.decision.action).toBe('allow');
    expect(wss.matchedRule).toBe('domain-allowlist');
  });

  it('blocks URLs with embedded credentials', async () => {
    const result = await evaluateNetworkPolicy({
      url: 'https://user:pass@example.com/api',
      source: 'mcp',
      allowedDomains: ['example.com'],
    });

    expect(result.decision.action).toBe('deny');
    expect(result.decision.action === 'deny' ? result.decision.code : '').toBe('NETWORK_URL_CREDENTIALS');
  });

  it('allows localhost only on explicitly allowed ports', async () => {
    const result = await evaluateNetworkPolicy({
      url: 'http://127.0.0.1:18789/rpc',
      source: 'renderer',
      allowLocalhostPorts: [18789],
      headers: {
        authorization: 'Bearer sk-local-gateway-token-abcdefghijklmnopqrstuvwxyz',
      },
    });

    expect(result.decision.action).toBe('allow');
    expect(result.matchedRule).toBe('localhost-port-allowlist');
  });

  it('keeps localhost allowlist port-specific', async () => {
    const allowed = await evaluateNetworkPolicy({
      url: 'http://localhost:18789/rpc',
      source: 'renderer',
      allowLocalhostPorts: [18789],
    });
    const denied = await evaluateNetworkPolicy({
      url: 'http://localhost:18790/rpc',
      source: 'renderer',
      allowLocalhostPorts: [18789],
    });

    expect(allowed.decision.action).toBe('allow');
    expect(denied.decision.action).toBe('deny');
  });

  it('blocks localhost on non-allowlisted ports', async () => {
    const result = await evaluateNetworkPolicy({
      url: 'http://localhost:22/',
      source: 'agent',
      allowLocalhostPorts: [18789],
    });

    expect(result.decision.action).toBe('deny');
    expect(result.decision.action === 'deny' ? result.decision.code : '').toBe('NETWORK_LOCALHOST_PORT_BLOCKED');
  });

  it('blocks integer and hex localhost encodings', async () => {
    const decimal = await evaluateNetworkPolicy({ url: 'http://2130706433:8080/', source: 'agent' });
    const hex = await evaluateNetworkPolicy({ url: 'http://0x7f000001:8080/', source: 'agent' });

    expect(decimal.decision.action).toBe('deny');
    expect(hex.decision.action).toBe('deny');
  });

  it('blocks private IPv4 networks and metadata addresses', async () => {
    await grantDomainAccess('169.254.169.254', {
      persistent: true,
      source: 'settings:security',
    });
    const privateResult = await evaluateNetworkPolicy({ url: 'http://192.168.1.1/admin', source: 'agent' });
    const metadataResult = await evaluateNetworkPolicy({ url: 'http://169.254.169.254/latest/meta-data', source: 'agent' });

    expect(privateResult.decision.action).toBe('deny');
    expect(privateResult.decision.action === 'deny' ? privateResult.decision.code : '').toBe('NETWORK_PRIVATE_ADDRESS_BLOCKED');
    expect(metadataResult.decision.action).toBe('deny');
  });

  it('allows explicitly granted intranet IPv4 hosts but still blocks metadata addresses', async () => {
    await grantDomainAccess('10.0.1.83', {
      persistent: true,
      source: 'settings:security',
    });
    await grantDomainAccess('169.254.169.254', {
      persistent: true,
      source: 'settings:security',
    });

    const intranetResult = await evaluateNetworkPolicy({
      url: 'http://10.0.1.83:8009/api/check-token',
      source: 'agent',
    });
    const metadataResult = await evaluateNetworkPolicy({
      url: 'http://169.254.169.254/latest/meta-data',
      source: 'agent',
    });

    expect(intranetResult.decision.action).toBe('allow');
    expect(intranetResult.matchedRule).toBe('domain-grant');
    expect(metadataResult.decision.action).toBe('deny');
    expect(metadataResult.matchedRule).toBe('private-address-hard-deny');
  });

  it('allows explicitly granted plain HTTP intranet hosts without another confirmation', async () => {
    await grantDomainAccess('10.0.1.83', {
      persistent: true,
      source: 'settings:security',
    });

    const result = await evaluateNetworkPolicy({
      url: 'http://10.0.1.83:8009/api/check-token',
      source: 'agent',
      intent: 'public-read',
      method: 'GET',
    });

    expect(result.decision.action).toBe('allow');
    expect(result.matchedRule).toBe('domain-grant');
  });

  it('blocks IPv6 localhost and local networks', async () => {
    const localhostResult = await evaluateNetworkPolicy({ url: 'http://[::1]:3000/', source: 'agent' });
    const localResult = await evaluateNetworkPolicy({ url: 'http://[fd00::1]/', source: 'agent' });

    expect(localhostResult.decision.action).toBe('deny');
    expect(localResult.decision.action).toBe('deny');
  });

  it('allows unknown public domains after explicit confirmation', async () => {
    const result = await evaluateNetworkPolicy({
      url: 'https://unreviewed.example.net/data',
      source: 'renderer',
      confirmed: true,
    });

    expect(result.decision.action).toBe('allow');
    expect(result.matchedRule).toBe('confirmed-public-domain');
  });

  it('assertNetworkAllowed throws stable codes for denied and prompt decisions', async () => {
    await expect(assertNetworkAllowed({ url: 'javascript:alert(1)', source: 'agent' }))
      .rejects.toThrow('Protocol javascript: is not allowed');

    try {
      await assertNetworkAllowed({ url: 'https://unreviewed.example.net/data', source: 'agent' });
      throw new Error('expected throw');
    } catch (error) {
      expect((error as Error & { code?: string }).code).toBe('NETWORK_REQUIRES_CONFIRMATION');
    }
  });
});
