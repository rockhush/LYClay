import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  assertGatewayRpcNetworkAllowed,
  extractHttpUrls,
} from '@electron/security/network-preflight';
import { grantDomainAccess, resetPermissionStoreForTests } from '@electron/security/permission-store';

async function useTempPermissionFile(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'clawx-network-preflight-'));
  process.env.CLAWX_SECURITY_PERMISSIONS_PATH = join(root, 'security-permissions.json');
  resetPermissionStoreForTests();
}

describe('network preflight for gateway chat messages', () => {
  beforeEach(async () => {
    await useTempPermissionFile();
  });

  it('extracts http URLs from natural-language messages', () => {
    expect(extractHttpUrls('Open https://www.baidu.com/, then summarize it.')).toEqual([
      'https://www.baidu.com/',
    ]);
    expect(extractHttpUrls('Open https://example.com/path).')).toEqual([
      'https://example.com/path',
    ]);
  });

  it('allows ordinary public HTTPS reads without storing a domain grant', async () => {
    await expect(assertGatewayRpcNetworkAllowed('chat.send', {
      message: 'Open https://www.baidu.com/',
    })).resolves.toBeUndefined();
  });

  it('still rejects private targets embedded in chat messages', async () => {
    await expect(assertGatewayRpcNetworkAllowed('chat.send', {
      message: 'Open http://169.254.169.254/latest/meta-data/',
    })).rejects.toMatchObject({
      code: 'NETWORK_PRIVATE_ADDRESS_BLOCKED',
    });
  });

  it('allows explicitly granted intranet hosts embedded in chat messages', async () => {
    await grantDomainAccess('10.0.1.83', {
      persistent: true,
      source: 'settings:security',
    });

    await expect(assertGatewayRpcNetworkAllowed('chat.send', {
      message: '访问 http://10.0.1.83:8009/api/check-token',
    })).resolves.toBeUndefined();
  });

  it('still requires confirmation for shortened URLs embedded in chat messages', async () => {
    await expect(assertGatewayRpcNetworkAllowed('chat.send', {
      message: 'Open https://bit.ly/example',
    })).rejects.toMatchObject({
      code: 'NETWORK_ACCESS_DENIED_BY_USER',
    });
  });

  it('ignores non-chat RPC methods', async () => {
    await expect(assertGatewayRpcNetworkAllowed('sessions.list', {
      message: 'https://unreviewed.example.net/',
    })).resolves.toBeUndefined();
  });
});
