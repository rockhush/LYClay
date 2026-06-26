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
    delete process.env.LYCLAW_TOOL_HARD_TIMEOUT_MS;
    delete process.env.LYCLAW_TOOL_IDLE_TIMEOUT_MS;
    delete process.env.LYCLAW_TOOL_TTL_MS;
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

  it('aborts tracked user chat runs when the gateway stops', async () => {
    const { GatewayManager } = await import('@electron/gateway/manager');
    const manager = new GatewayManager();
    const emitted: unknown[] = [];
    manager.on('chat:message', (event) => emitted.push(event));

    (manager as unknown as {
      chatRunMetrics: Map<string, Record<string, unknown>>;
    }).chatRunMetrics.set('run-restart', {
      kind: 'user',
      sessionKey: 'agent:main:session-123',
      requestedAt: Date.now() - 20,
      acceptedAt: Date.now() - 10,
      rpcDurationMs: 10,
    });

    await manager.stop();

    expect(emitted).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({
          state: 'aborted',
          runId: 'run-restart',
          sessionKey: 'agent:main:session-123',
          reason: 'gateway-stopped',
        }),
      }),
    ]);
    expect(manager.hasTrackedUserRunForSession('agent:main:session-123')).toBe(false);
  });

  it('keeps a running exec handle tracked after user-visible final and feeds timeout back to the model', async () => {
    process.env.LYCLAW_TOOL_HARD_TIMEOUT_MS = '50';
    process.env.LYCLAW_TOOL_IDLE_TIMEOUT_MS = '5000';
    process.env.LYCLAW_TOOL_TTL_MS = '5000';
    vi.useFakeTimers();
    const { GatewayManager } = await import('@electron/gateway/manager');
    const manager = new GatewayManager();
    const sessionKey = 'agent:main:session-123';
    const runId = 'run-background-exec';
    const rpc = vi.fn(async (method: string) => {
      if (method === 'process') return { ok: true };
      if (method === 'chat.send') return { runId: 'internal-feedback-run' };
      return {};
    });
    (manager as unknown as { rpc: typeof rpc }).rpc = rpc;
    const emitted: unknown[] = [];
    manager.on('chat:message', (event) => emitted.push(event));

    (manager as unknown as {
      chatRunMetrics: Map<string, Record<string, unknown>>;
      recordChatEventTiming: (payload: unknown) => void;
    }).chatRunMetrics.set(runId, {
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
      runId,
      message: {
        role: 'toolResult',
        toolCallId: 'call-exec',
        toolName: 'exec',
        content: [{
          type: 'text',
          text: 'Command still running (session dawn-coral, pid 28132). Use process for follow-up.',
        }],
        details: {
          status: 'running',
          sessionId: 'dawn-coral',
          pid: 28132,
          startedAt: Date.now(),
        },
      },
    });
    (manager as unknown as {
      recordChatEventTiming: (payload: unknown) => void;
    }).recordChatEventTiming({
      state: 'final',
      runId,
      message: { role: 'assistant', content: [{ type: 'text', text: '已成功在后台启动命令。' }] },
    });

    expect(manager.getDiagnostics().activeToolRuns).toEqual([
      expect.objectContaining({
        status: 'running',
        sessionKey,
        runId,
        toolCallId: 'call-exec',
        handle: expect.objectContaining({ id: 'dawn-coral', pid: 28132 }),
      }),
    ]);

    await vi.advanceTimersByTimeAsync(55);

    expect(rpc).toHaveBeenCalledWith('process', { action: 'kill', sessionId: 'dawn-coral' }, 8_000);
    expect(rpc).toHaveBeenCalledWith('process', { action: 'remove', sessionId: 'dawn-coral' }, 8_000);
    expect(rpc).toHaveBeenCalledWith(
      'chat.send',
      expect.objectContaining({
        sessionKey,
        deliver: false,
        message: expect.stringContaining('[LYCLAW internal tool failure feedback]'),
      }),
      120_000,
    );
    expect(emitted).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({
          state: 'tool_timeout',
          runId,
          sessionKey,
        }),
      }),
    ]);
  });
  it('cancels tracked process handles when sessions.abort is requested', async () => {
    process.env.LYCLAW_TOOL_HARD_TIMEOUT_MS = '5000';
    process.env.LYCLAW_TOOL_IDLE_TIMEOUT_MS = '5000';
    process.env.LYCLAW_TOOL_TTL_MS = '5000';
    vi.useFakeTimers();
    const { GatewayManager } = await import('@electron/gateway/manager');
    const manager = new GatewayManager();
    const sessionKey = 'agent:main:session-123';
    const runId = 'run-cancel-exec';
    const rpc = vi.fn(async (method: string) => {
      if (method === 'process') return { ok: true };
      if (method === 'sessions.abort') return { ok: true };
      if (method === 'chat.send') return { runId: 'unexpected-feedback-run' };
      return {};
    });
    (manager as unknown as { rpc: typeof rpc }).rpc = rpc;
    const emitted: unknown[] = [];
    manager.on('chat:message', (event) => emitted.push(event));

    (manager as unknown as {
      recordChatEventTiming: (payload: unknown) => void;
    }).recordChatEventTiming({
      state: 'final',
      runId,
      sessionKey,
      message: {
        role: 'toolResult',
        toolCallId: 'call-exec',
        toolName: 'exec',
        content: [{ type: 'text', text: 'Command still running (session cancel-coral, pid 28133).' }],
        details: { status: 'running', sessionId: 'cancel-coral', pid: 28133, startedAt: Date.now() },
      },
    });

    await (manager as unknown as {
      handleToolLifecycleRpcSideEffects: (method: string, params?: unknown) => Promise<void>;
    }).handleToolLifecycleRpcSideEffects('sessions.abort', { key: sessionKey, runId });

    expect(rpc).toHaveBeenCalledWith('process', { action: 'kill', sessionId: 'cancel-coral' }, 8_000);
    expect(rpc).toHaveBeenCalledWith('process', { action: 'remove', sessionId: 'cancel-coral' }, 8_000);
    expect(rpc).not.toHaveBeenCalledWith('chat.send', expect.anything(), expect.anything());
    expect(emitted).toEqual([]);
    expect(manager.getDiagnostics().terminalToolRuns).toEqual([
      expect.objectContaining({ status: 'cancelled', terminalReason: 'user-cancelled' }),
    ]);
  });

  it('removes completed background process handles without killing them', async () => {
    const { GatewayManager } = await import('@electron/gateway/manager');
    const manager = new GatewayManager();
    const sessionKey = 'agent:main:session-123';
    const runId = 'run-complete-exec';
    const rpc = vi.fn(async () => ({ ok: true }));
    (manager as unknown as { rpc: typeof rpc }).rpc = rpc;

    (manager as unknown as {
      recordChatEventTiming: (payload: unknown) => void;
    }).recordChatEventTiming({
      state: 'final',
      runId,
      sessionKey,
      message: {
        role: 'toolResult',
        toolCallId: 'call-exec',
        toolName: 'exec',
        content: [{ type: 'text', text: 'Command still running (session done-coral, pid 28134).' }],
        details: { status: 'running', sessionId: 'done-coral', pid: 28134, startedAt: Date.now() },
      },
    });
    (manager as unknown as {
      recordChatEventTiming: (payload: unknown) => void;
    }).recordChatEventTiming({
      state: 'final',
      runId,
      sessionKey,
      message: {
        role: 'toolResult',
        toolCallId: 'call-exec',
        toolName: 'exec',
        content: [{ type: 'text', text: 'done\n(Command exited with code 0)' }],
        details: { status: 'completed', sessionId: 'done-coral', pid: 28134 },
      },
    });
    await Promise.resolve();

    expect(rpc).not.toHaveBeenCalledWith('process', { action: 'kill', sessionId: 'done-coral' }, 8_000);
    expect(rpc).toHaveBeenCalledWith('process', { action: 'remove', sessionId: 'done-coral' }, 8_000);
    expect(manager.getDiagnostics().terminalToolRuns).toEqual([
      expect.objectContaining({ status: 'completed', terminalReason: 'completed' }),
    ]);
  });
  it('exposes tool run quota and background process counts in diagnostics', async () => {
    const { GatewayManager } = await import('@electron/gateway/manager');
    const manager = new GatewayManager();
    (manager as unknown as {
      recordChatEventTiming: (payload: unknown) => void;
    }).recordChatEventTiming({
      state: 'final',
      runId: 'run-diagnostics-exec',
      sessionKey: 'agent:main:session-123',
      message: {
        role: 'toolResult',
        toolCallId: 'call-exec',
        toolName: 'exec',
        content: [{ type: 'text', text: 'Command still running (session diag-coral, pid 28135).' }],
        details: { status: 'running', sessionId: 'diag-coral', pid: 28135, startedAt: Date.now() },
      },
    });

    expect(manager.getDiagnostics()).toMatchObject({
      activeBackgroundProcessCount: 1,
      killFailedToolRunCount: 0,
      toolRunQuota: expect.objectContaining({ activeGlobal: 1 }),
    });
  });

  it('limits repeated tool failure feedback sent back to the model', async () => {
    process.env.LYCLAW_TOOL_HARD_TIMEOUT_MS = '20';
    process.env.LYCLAW_TOOL_IDLE_TIMEOUT_MS = '5000';
    process.env.LYCLAW_TOOL_TTL_MS = '5000';
    vi.useFakeTimers();
    const { GatewayManager } = await import('@electron/gateway/manager');
    const manager = new GatewayManager();
    const sessionKey = 'agent:main:session-123';
    const rpc = vi.fn(async (method: string) => {
      if (method === 'process') return { ok: true };
      if (method === 'chat.send') return { runId: 'internal-feedback-run' };
      return {};
    });
    (manager as unknown as { rpc: typeof rpc }).rpc = rpc;

    for (let index = 0; index < 3; index += 1) {
      (manager as unknown as {
        recordChatEventTiming: (payload: unknown) => void;
      }).recordChatEventTiming({
        state: 'final',
        runId: `run-repeat-${index}`,
        sessionKey,
        message: {
          role: 'toolResult',
          toolCallId: `call-exec-${index}`,
          toolName: 'exec',
          content: [{ type: 'text', text: `Command still running (session repeat-coral-${index}, pid ${28200 + index}).` }],
          details: { status: 'running', sessionId: `repeat-coral-${index}`, pid: 28200 + index, startedAt: Date.now() },
        },
      });
      await vi.advanceTimersByTimeAsync(25);
    }

    const feedbackCalls = rpc.mock.calls.filter(([method]) => method === 'chat.send');
    expect(feedbackCalls).toHaveLength(2);
  });
});
