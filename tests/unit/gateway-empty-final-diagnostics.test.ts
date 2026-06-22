import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp',
    isPackaged: false,
  },
  utilityProcess: {
    fork: vi.fn(),
  },
}));

vi.mock('@electron/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@electron/utils/uv-env', () => ({
  getUvMirrorEnv: vi.fn(async () => ({})),
  shouldOptimizeNetwork: vi.fn(async () => false),
  warmupNetworkOptimization: vi.fn(async () => undefined),
}));

describe('GatewayManager empty final diagnostics', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('logs session snapshot and recovery result for an empty user chat final', async () => {
    const { GatewayManager } = await import('@electron/gateway/manager');
    const { logger } = await import('@electron/utils/logger');
    const manager = new GatewayManager();
    const sessionKey = 'agent:main:session-123';

    (manager as unknown as {
      getEmptyFinalSessionSnapshot: (sessionKey?: string) => Promise<Record<string, unknown>>;
    }).getEmptyFinalSessionSnapshot = vi.fn(async () => ({
      sessionStoreEntry: {
        status: 'done',
        sessionFile: 'session-123.jsonl',
      },
      transcriptLockOwner: {
        pid: 999999,
        pidAlive: false,
      },
    }));
    (manager as unknown as {
      recoverSessionTranscriptLock: (sessionKey?: string, reason?: string) => Promise<Record<string, unknown>>;
    }).recoverSessionTranscriptLock = vi.fn(async () => ({
      recovered: false,
      reason: 'lock-owned-by-other-process',
    }));

    await (manager as unknown as {
      recordEmptyUserChatFinalDiagnostic: (args: Record<string, unknown>) => Promise<void>;
    }).recordEmptyUserChatFinalDiagnostic({
      runId: 'run-empty-final',
      sessionKey,
      totalSinceAcceptedMs: 25,
      totalSinceRequestedMs: 40,
      timeToFirstEventMs: 2,
      timeToFirstDeltaMs: null,
      timeToFirstVisibleProgressMs: null,
      rpcDurationMs: 15,
      trackedChatRunsBeforeCompletion: [],
    });

    expect(logger.warn).toHaveBeenCalledWith(
      '[gateway:session-lock-recovery] user chat run completed without a message',
      expect.objectContaining({
        runId: 'run-empty-final',
        sessionKey,
        recoveryResult: expect.objectContaining({ recovered: false, reason: 'lock-owned-by-other-process' }),
        sessionStoreEntry: expect.objectContaining({ status: 'done' }),
        transcriptLockOwner: expect.objectContaining({ pid: 999999, pidAlive: false }),
      }),
    );
    expect(manager.getLatestEmptyFinalDiagnostic(sessionKey)).toMatchObject({
      runId: 'run-empty-final',
      sessionKey,
      recoveryResult: expect.objectContaining({ recovered: false, reason: 'lock-owned-by-other-process' }),
      transcriptLockOwner: expect.objectContaining({ pid: 999999, pidAlive: false }),
    });
  }, 30_000);

  it('audits a user session transcript lock shortly after a terminal run', async () => {
    vi.useFakeTimers();
    const { GatewayManager } = await import('@electron/gateway/manager');
    const { logger } = await import('@electron/utils/logger');
    const manager = new GatewayManager();
    const sessionKey = 'agent:main:session-123';
    const recoverSessionTranscriptLock = vi.fn(async () => ({
      recovered: true,
      lockPath: '/tmp/session.jsonl.lock',
      sessionFile: '/tmp/session.jsonl',
      lockAgeMs: 12_000,
    }));
    (manager as unknown as {
      recoverSessionTranscriptLock: typeof recoverSessionTranscriptLock;
    }).recoverSessionTranscriptLock = recoverSessionTranscriptLock;

    (manager as unknown as {
      chatRunMetrics: Map<string, Record<string, unknown>>;
      recordChatEventTiming: (payload: unknown) => void;
    }).chatRunMetrics.set('run-final', {
      kind: 'user',
      sessionKey,
      requestedAt: Date.now(),
      acceptedAt: Date.now(),
      rpcDurationMs: 10,
    });
    (manager as unknown as {
      recordChatEventTiming: (payload: unknown) => void;
    }).recordChatEventTiming({
      state: 'final',
      runId: 'run-final',
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    });

    expect(recoverSessionTranscriptLock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(recoverSessionTranscriptLock).toHaveBeenCalledWith(
      sessionKey,
      'terminal-user-chat-final',
    );
    expect(logger.info).toHaveBeenCalledWith(
      '[gateway:session-lock-recovery] terminal lock audit completed',
      expect.objectContaining({
        sessionKey,
        runId: 'run-final',
        state: 'final',
        recovered: true,
      }),
    );
  });
});
