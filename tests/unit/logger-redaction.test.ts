import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let testUserDataDir = '';

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return false;
    },
    getPath: () => testUserDataDir,
    getVersion: () => '0.0.0-test',
  },
}));

const bearer = 'Bearer abcdefghijklmnopqrstuvwxyz123456';
const providerToken = 'sk-abcdefghijklmnopqrstuvwxyz1234567890';
const githubToken = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890';

describe('logger secret redaction', () => {
  beforeEach(async () => {
    testUserDataDir = await mkdtemp(join(tmpdir(), 'clawx-logger-redaction-'));
    vi.resetModules();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(testUserDataDir, { recursive: true, force: true });
  });

  it('redacts messages, objects, and errors before adding them to recent logs', async () => {
    const { logger } = await import('@electron/utils/logger');

    logger.info(`calling ${bearer}`, {
      authorization: bearer,
      url: `https://user:pass@example.com/path?api_key=${providerToken}`,
      nested: {
        message: `token=${githubToken}`,
      },
    });
    logger.error('request failed', new Error(`remote rejected ${providerToken}`));

    const logs = logger.getRecentLogs(10).join('\n');
    expect(logs).toContain('Bearer [REDACTED]');
    expect(logs).toContain('https://[REDACTED]@example.com/path?api_key=[REDACTED]');
    expect(logs).toContain('"authorization": "[REDACTED]"');
    expect(logs).toContain('token=[REDACTED]');
    expect(logs).not.toContain(bearer);
    expect(logs).not.toContain(providerToken);
    expect(logs).not.toContain(githubToken);
    expect(logs).not.toContain('user:pass');
  });

  it('redacts secrets when reading existing log tails', async () => {
    const { logger, getLogFilePath, initLogger } = await import('@electron/utils/logger');
    initLogger();
    const logFilePath = getLogFilePath();
    expect(logFilePath).toBeTruthy();

    await writeFile(
      logFilePath!,
      `line one\nleaked ${bearer}\nurl https://user:pass@example.com/?api_key=${providerToken}\n`,
      'utf8',
    );

    const tail = await logger.readLogFile(5);
    expect(tail).toContain('Bearer [REDACTED]');
    expect(tail).toContain('https://[REDACTED]@example.com/?api_key=[REDACTED]');
    expect(tail).not.toContain(bearer);
    expect(tail).not.toContain(providerToken);
    expect(tail).not.toContain('user:pass');
  });
});
