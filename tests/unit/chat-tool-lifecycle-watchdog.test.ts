import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatState } from '@/stores/chat/types';

const invokeIpcMock = vi.fn();

vi.mock('@/lib/api-client', () => ({
  invokeIpc: (...args: unknown[]) => invokeIpcMock(...args),
}));

function makeHarness(initial?: Partial<ChatState>) {
  let state = {
    currentSessionKey: 'agent:main:main',
    activeRunId: 'run-1',
    activeTool: null,
    sessionStreamingStates: {},
    streamingTools: [],
    sending: true,
    error: null,
    runError: null,
    streamingText: '',
    streamingMessage: null,
    pendingFinal: true,
    pendingToolImages: [],
    lastUserMessageAt: 123,
    ...initial,
  } as unknown as ChatState;

  const set = (partial: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) => {
    const next = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...next };
  };
  const get = () => state;
  return { set, get, read: () => state };
}

describe('tool lifecycle watchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-18T05:09:27.000Z'));
    invokeIpcMock.mockReset();
    invokeIpcMock.mockResolvedValue({ success: true });
    (globalThis as unknown as Record<string, unknown>).__LYCLAW_TOOL_WATCHDOG_HARD_TIMEOUT_MS__ = 1_000;
    (globalThis as unknown as Record<string, unknown>).__LYCLAW_TOOL_WATCHDOG_IDLE_TIMEOUT_MS__ = 1_000;
  });

  afterEach(() => {
    delete (globalThis as unknown as Record<string, unknown>).__LYCLAW_TOOL_WATCHDOG_HARD_TIMEOUT_MS__;
    delete (globalThis as unknown as Record<string, unknown>).__LYCLAW_TOOL_WATCHDOG_IDLE_TIMEOUT_MS__;
    vi.useRealTimers();
  });

  it('detects exec tool results that return a running background handle', async () => {
    const { getRunningToolSnapshotFromMessage } = await import('@/stores/chat/tool-lifecycle-watchdog');

    const snapshot = getRunningToolSnapshotFromMessage({
      role: 'toolresult',
      toolCallId: 'call-1',
      toolName: 'exec',
      content: [{ type: 'text', text: 'Command still running (session dawn-glade, pid 29956).' }],
    }, {
      sessionKey: 'agent:main:main',
      runId: 'run-1',
    });

    expect(snapshot).toMatchObject({
      sessionKey: 'agent:main:main',
      runId: 'run-1',
      toolCallId: 'call-1',
      toolName: 'exec',
      status: 'running',
      handle: {
        kind: 'exec-session',
        id: 'dawn-glade',
        pid: 29956,
      },
    });
  });

  it('settles a foreground run with a tool timeout and aborts the gateway run', async () => {
    const {
      getRunningToolSnapshotFromMessage,
      trackRunningTool,
    } = await import('@/stores/chat/tool-lifecycle-watchdog');
    const h = makeHarness();
    const snapshot = getRunningToolSnapshotFromMessage({
      role: 'toolresult',
      toolCallId: 'call-1',
      toolName: 'exec',
      content: [{ type: 'text', text: 'Command still running (session dawn-glade, pid 29956).' }],
    }, {
      sessionKey: 'agent:main:main',
      runId: 'run-1',
    });
    expect(snapshot).not.toBeNull();

    trackRunningTool(h.set, h.get, snapshot!, true);
    expect(h.read().activeTool?.status).toBe('running');

    await vi.advanceTimersByTimeAsync(1_001);

    const state = h.read();
    expect(state.activeTool?.status).toBe('timeout');
    expect(state.activeTool?.terminalReason).toBe('idle-timeout');
    expect(state.sending).toBe(false);
    expect(state.activeRunId).toBeNull();
    expect(state.runError).toContain('工具调用超时');
    expect(state.streamingTools).toEqual([
      expect.objectContaining({
        toolCallId: 'call-1',
        name: 'exec',
        status: 'error',
      }),
    ]);
    expect(invokeIpcMock).toHaveBeenCalledWith(
      'gateway:rpc',
      'sessions.abort',
      { key: 'agent:main:main', runId: 'run-1' },
      8_000,
    );
  });
});
