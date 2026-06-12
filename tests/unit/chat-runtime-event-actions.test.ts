import { beforeEach, describe, expect, it, vi } from 'vitest';

const clearHistoryPoll = vi.fn();
const forgetAbortedChatRun = vi.fn();
const isAbortedChatRun = vi.fn(() => false);
const setLastChatEventAt = vi.fn();
const handleRuntimeEventState = vi.fn();

vi.mock('@/stores/chat/helpers', () => ({
  clearHistoryPoll,
  forgetAbortedChatRun,
  isAbortedChatRun,
  setLastChatEventAt,
}));

describe('chat runtime event actions', () => {
  beforeEach(() => {
    vi.resetModules();
    clearHistoryPoll.mockClear();
    forgetAbortedChatRun.mockClear();
    isAbortedChatRun.mockReturnValue(false);
    setLastChatEventAt.mockClear();
    handleRuntimeEventState.mockClear();
    vi.doMock('@/stores/chat/runtime-event-handlers', () => ({
      handleRuntimeEventState,
    }));
  });

  it('forwards events with missing sessionKey to known background session by runId', async () => {
    const { createRuntimeEventActions } = await import('@/stores/chat/runtime-event-actions');
    const state = {
      activeRunId: 'current-run',
      currentSessionKey: 'session:current',
      sessionStreamingStates: {
        'session:background': {
          activeRunId: 'background-run',
          streamingText: '',
          streamingMessage: null,
          streamingTools: [],
          pendingFinal: false,
          lastUserMessageAt: null,
          pendingToolImages: [],
          runAborted: false,
          sending: false,
          messagesSnapshot: [],
        },
      },
      sending: false,
      error: 'old',
    };
    const set = vi.fn((partial: Record<string, unknown> | ((s: typeof state) => Record<string, unknown>)) => {
      const next = typeof partial === 'function' ? partial(state) : partial;
      Object.assign(state, next);
    });
    const get = vi.fn(() => state);
    const { handleChatEvent } = createRuntimeEventActions(set as any, get as any);

    handleChatEvent({ runId: 'background-run', state: 'delta', message: { role: 'assistant', content: 'hi' } });

    expect(handleRuntimeEventState).toHaveBeenCalledTimes(1);
    expect(handleRuntimeEventState).toHaveBeenCalledWith(
      set,
      get,
      expect.objectContaining({ runId: 'background-run', state: 'delta' }),
      'delta',
      'background-run',
    );
  });

  it('ignores events with missing sessionKey and unknown runId', async () => {
    const { createRuntimeEventActions } = await import('@/stores/chat/runtime-event-actions');
    const state = {
      activeRunId: 'current-run',
      currentSessionKey: 'session:current',
      sessionStreamingStates: {
        'session:background': {
          activeRunId: 'background-run',
          streamingText: '',
          streamingMessage: null,
          streamingTools: [],
          pendingFinal: false,
          lastUserMessageAt: null,
          pendingToolImages: [],
          runAborted: false,
          sending: false,
          messagesSnapshot: [],
        },
      },
      sending: false,
      error: 'old',
    };
    const set = vi.fn((partial: Record<string, unknown> | ((s: typeof state) => Record<string, unknown>)) => {
      const next = typeof partial === 'function' ? partial(state) : partial;
      Object.assign(state, next);
    });
    const get = vi.fn(() => state);
    const { handleChatEvent } = createRuntimeEventActions(set as any, get as any);

    handleChatEvent({ runId: 'unknown-run', state: 'delta', message: { role: 'assistant', content: 'hi' } });

    expect(handleRuntimeEventState).not.toHaveBeenCalled();
  });
});
