import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, describe, expect, it } from 'vitest';
import { evaluateOpenTargetPolicy } from '@electron/security/open-target-policy';
import { resetPermissionStoreForTests } from '@electron/security/permission-store';

async function makeWorkspace(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), 'clawx-open-target-'));
}

describe('open target security policy', () => {
  beforeEach(() => {
    process.env.CLAWX_SECURITY_PERMISSIONS_PATH = path.join(tmpdir(), `clawx-open-target-${Math.random()}.json`);
    resetPermissionStoreForTests();
  });

  it('converts file URLs to local file opens and applies path policy', async () => {
    const workspace = await makeWorkspace();
    const filePath = path.join(workspace, 'README.md');
    await writeFile(filePath, '# hello');

    const result = await evaluateOpenTargetPolicy({
      target: pathToFileURL(filePath).toString(),
      capability: 'open-external',
      allowedRoots: [workspace],
      source: 'test',
    });

    expect(result).toMatchObject({
      targetType: 'file',
      action: 'open-path',
      decision: { action: 'allow' },
    });
    expect(result.realPath?.toLowerCase()).toContain('readme.md');
  });

  it('blocks file URLs that point at sensitive paths', async () => {
    const workspace = await makeWorkspace();
    const sshDir = path.join(workspace, '.ssh');
    await mkdir(sshDir);
    const keyPath = path.join(sshDir, 'id_rsa');
    await writeFile(keyPath, 'secret');

    const result = await evaluateOpenTargetPolicy({
      target: pathToFileURL(keyPath).toString(),
      capability: 'open-external',
      allowedRoots: [workspace],
      source: 'test',
    });

    expect(result.decision.action).toBe('deny');
    expect(result.decision.action === 'deny' ? result.decision.code : '').toBe('SENSITIVE_PATH');
  });

  it('blocks dangerous URL protocols', async () => {
    const result = await evaluateOpenTargetPolicy({
      target: 'javascript:alert(1)',
      capability: 'open-external',
      source: 'test',
    });

    expect(result.decision.action).toBe('deny');
    expect(result.decision.action === 'deny' ? result.decision.code : '').toBe('OPEN_TARGET_PROTOCOL_BLOCKED');
  });

  it('allows ordinary HTTPS links as public reads', async () => {
    await expect(evaluateOpenTargetPolicy({
      target: 'https://www.theverge.com/ai-artificial-intelligence',
      capability: 'open-external',
      source: 'test',
    })).resolves.toMatchObject({
      targetType: 'url',
      action: 'open-url',
      hostname: 'www.theverge.com',
      matchedRule: 'public-https-read',
      decision: { action: 'allow' },
    });
  });

  it.each([
    ['plain HTTP', 'http://www.theverge.com/ai', 'public-read-insecure-http'],
    ['short URL', 'https://bit.ly/example', 'public-read-short-url'],
    ['raw IP', 'https://8.8.8.8/news', 'public-read-ip-address'],
    ['non-default port', 'https://www.theverge.com:8443/ai', 'public-read-non-default-port'],
    ['dangerous download', 'https://downloads.example.com/setup.exe', 'dangerous-download'],
  ])('still prompts for %s links', async (_label, target, matchedRule) => {
    await expect(evaluateOpenTargetPolicy({
      target,
      capability: 'open-external',
      source: 'test',
    })).resolves.toMatchObject({
      targetType: 'url',
      action: 'open-url',
      matchedRule,
      decision: { action: 'prompt' },
    });
  });

  it('prompts for mailto and blocks custom protocols', async () => {
    await expect(evaluateOpenTargetPolicy({
      target: 'mailto:test@example.com',
      capability: 'open-external',
      source: 'test',
    })).resolves.toMatchObject({
      decision: { action: 'prompt' },
      protocol: 'mailto:',
    });

    await expect(evaluateOpenTargetPolicy({
      target: 'vscode://file/c:/tmp/a.ts',
      capability: 'open-external',
      source: 'test',
    })).resolves.toMatchObject({
      decision: { action: 'deny' },
      protocol: 'vscode:',
    });
  });

  it('uses metadata capability for show item in folder', async () => {
    const workspace = await makeWorkspace();
    const filePath = path.join(workspace, 'a.txt');
    await writeFile(filePath, 'hello');

    const result = await evaluateOpenTargetPolicy({
      target: filePath,
      capability: 'show-item',
      allowedRoots: [workspace],
      source: 'test',
    });

    expect(result).toMatchObject({
      action: 'show-item',
      decision: { action: 'allow' },
    });
    expect(result.realPath?.toLowerCase()).toContain('a.txt');
  });
});
