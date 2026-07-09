import { beforeEach, describe, expect, it, vi } from 'vitest';

const clearHistoryPoll = vi.fn();
const forgetAbortedChatRun = vi.fn();
const isAbortedChatRun = vi.fn(() => false);
const setLastChatEventAt = vi.fn();
const handleRuntimeEventState = vi.fn();
const collectToolUpdates = vi.fn(() => []);
const getMessageText = vi.fn((content: unknown) => typeof content === 'string' ? content : '');
const hasVisibleAssistantContent = vi.fn((message: { content?: unknown } | undefined) =>
  Boolean(getMessageText(message?.content).trim()));
const hasNonToolAssistantContent = hasVisibleAssistantContent;
const isInternalMessageText = vi.fn(() => false);
const isToolOnlyMessage = vi.fn(() => false);
const isToolResultRole = vi.fn((role: unknown) => role === 'toolresult' || role === 'toolResult' || role === 'tool_result');
const normalizeStreamingMessage = vi.fn((message: unknown) => message);
const shouldSuppressAssistantStreamingText = vi.fn(() => false);
const upsertToolStatuses = vi.fn((_current, updates) => updates);

vi.mock('@/stores/chat/helpers', () => ({
  clearHistoryPoll,
  collectToolUpdates,
  forgetAbortedChatRun,
  getMessageText,
  hasNonToolAssistantContent,
  hasVisibleAssistantContent,
  isAbortedChatRun,
  isInternalMessageText,
  isToolOnlyMessage,
  isToolResultRole,
  normalizeStreamingMessage,
  setLastChatEventAt,
  shouldSuppressAssistantStreamingText,
  upsertToolStatuses,
}));

describe('chat runtime event actions', () => {
  beforeEach(() => {
    vi.resetModules();
    clearHistoryPoll.mockClear();
    forgetAbortedChatRun.mockClear();
    isAbortedChatRun.mockReturnValue(false);
    setLastChatEventAt.mockClear();
    handleRuntimeEventState.mockClear();
    collectToolUpdates.mockReturnValue([]);
    getMessageText.mockImplementation((content: unknown) => typeof content === 'string' ? content : '');
    hasVisibleAssistantContent.mockImplementation((message: { content?: unknown } | undefined) =>
      Boolean(getMessageText(message?.content).trim()));
    isInternalMessageText.mockReturnValue(false);
    isToolOnlyMessage.mockReturnValue(false);
    isToolResultRole.mockImplementation((role: unknown) => role === 'toolresult' || role === 'toolResult' || role === 'tool_result');
    normalizeStreamingMessage.mockImplementation((message: unknown) => message);
    shouldSuppressAssistantStreamingText.mockReturnValue(false);
    upsertToolStatuses.mockImplementation((_current, updates) => updates);
    vi.doMock('@/stores/chat/runtime-event-handlers', () => ({
      handleRuntimeEventState,
    }));
  });

  it('captures events with missing sessionKey to known background session by runId', async () => {
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
      runawayToolObservation: null,
      sessionRunawayToolObservations: {},
    };
    const set = vi.fn((partial: Record<string, unknown> | ((s: typeof state) => Record<string, unknown>)) => {
      const next = typeof partial === 'function' ? partial(state) : partial;
      Object.assign(state, next);
    });
    const get = vi.fn(() => state);
    const { handleChatEvent } = createRuntimeEventActions(set as any, get as any);

    handleChatEvent({ runId: 'background-run', state: 'delta', message: { role: 'assistant', content: 'hi' } });

    expect(handleRuntimeEventState).not.toHaveBeenCalled();
    expect(state.sessionStreamingStates['session:background']).toEqual(expect.objectContaining({
      activeRunId: 'background-run',
      sending: true,
      streamingMessage: { role: 'assistant', content: 'hi' },
    }));
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
      runawayToolObservation: null,
      sessionRunawayToolObservations: {},
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

  it('captures explicit background deltas when Gateway reports the session is processing', async () => {
    const { createRuntimeEventActions } = await import('@/stores/chat/runtime-event-actions');
    const state = {
      activeRunId: null,
      currentSessionKey: 'agent:main:visible',
      sessionStreamingStates: {},
      gatewayBackgroundActivity: {
        hasBackgroundProcessing: true,
        processingSessionKeys: ['agent:main:background'],
      },
      sessionBackendActivity: null,
      sending: false,
      error: null,
      runawayToolObservation: null,
      sessionRunawayToolObservations: {},
    };
    const set = vi.fn((partial: Record<string, unknown> | ((s: typeof state) => Record<string, unknown>)) => {
      const next = typeof partial === 'function' ? partial(state) : partial;
      Object.assign(state, next);
    });
    const get = vi.fn(() => state);
    const { handleChatEvent } = createRuntimeEventActions(set as any, get as any);

    handleChatEvent({
      sessionKey: 'agent:main:background',
      runId: 'run-background',
      state: 'delta',
      message: { role: 'assistant', content: 'still working' },
    });

    expect(handleRuntimeEventState).not.toHaveBeenCalled();
    expect(state.sessionStreamingStates['agent:main:background']).toEqual(expect.objectContaining({
      activeRunId: 'run-background',
      sending: true,
      streamingMessage: { role: 'assistant', content: 'still working' },
    }));
  });
});
