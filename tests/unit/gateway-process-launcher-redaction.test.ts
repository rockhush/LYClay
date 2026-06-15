import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockFork } = vi.hoisted(() => ({
  mockFork: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => '/tmp',
  },
  utilityProcess: {
    fork: mockFork,
  },
}));

vi.mock('@electron/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@electron/utils/child-output-encoding', () => ({
  buildUtf8ChildProcessEnv: (env: Record<string, string | undefined>) => env,
  decodeChildProcessOutput: (data: Buffer | string) => Buffer.isBuffer(data) ? data.toString('utf8') : data,
}));

class MockUtilityChild extends EventEmitter {
  pid = 4321;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

const providerToken = 'sk-abcdefghijklmnopqrstuvwxyz1234567890';

function launchOptions(overrides: Record<string, unknown> = {}) {
  return {
    port: 18789,
    launchContext: {
      openclawDir: '/tmp/openclaw',
      entryScript: '/tmp/openclaw/openclaw.mjs',
      gatewayArgs: ['gateway', '--port', '18789'],
      forkEnv: {},
      mode: 'dev',
      binPathExists: true,
      npmRuntimeReady: true,
      loadedProviderKeyCount: 1,
      proxySummary: 'none',
      channelStartupSummary: 'none',
    },
    sanitizeSpawnArgs: (args: string[]) => args,
    getCurrentState: () => 'starting',
    getShouldReconnect: () => true,
    onStderrLine: vi.fn(),
    onStdoutLine: vi.fn(),
    onSpawn: vi.fn(),
    onExit: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
}

describe('Gateway process launcher redaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('redacts Gateway stdout and stderr before invoking manager callbacks', async () => {
    const child = new MockUtilityChild();
    mockFork.mockReturnValue(child);
    const options = launchOptions();
    const { launchGatewayProcess } = await import('@electron/gateway/process-launcher');
    const pending = launchGatewayProcess(options as never);

    child.emit('spawn');
    await pending;
    child.stdout.emit('data', Buffer.from(`stdout api_key=${providerToken}\n`));
    child.stderr.emit('data', Buffer.from(`stderr Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456\n`));

    expect(options.onStdoutLine).toHaveBeenCalledWith('stdout api_key=[REDACTED]');
    expect(options.onStderrLine).toHaveBeenCalledWith('stderr Authorization: Bearer [REDACTED]');
    expect(JSON.stringify(options.onStdoutLine.mock.calls)).not.toContain(providerToken);
  });

  it('redacts Gateway spawn errors before forwarding or rejecting them', async () => {
    const child = new MockUtilityChild();
    mockFork.mockReturnValue(child);
    const options = launchOptions();
    const { launchGatewayProcess } = await import('@electron/gateway/process-launcher');
    const pending = launchGatewayProcess(options as never);

    child.emit('error', new Error(`spawn failed token=${providerToken}`));

    await expect(pending).rejects.toThrow('spawn failed token=[REDACTED]');
    expect(options.onError).toHaveBeenCalledWith(expect.objectContaining({
      message: 'spawn failed token=[REDACTED]',
    }));
  });
});
