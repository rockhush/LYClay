import { beforeEach, describe, expect, it, vi } from 'vitest';

const { gatewayRpcMock, hostApiFetchMock, getSessionBackendActivityMock, agentsState } = vi.hoisted(() => ({
  gatewayRpcMock: vi.fn(),
  hostApiFetchMock: vi.fn(),
  getSessionBackendActivityMock: vi.fn(),
  agentsState: {
    agents: [] as Array<Record<string, unknown>>,
  },
}));

vi.mock('@/stores/gateway', () => ({
  useGatewayStore: {
    getState: () => ({
      status: { state: 'running', port: 18789 },
      rpc: gatewayRpcMock,
    }),
  },
}));

vi.mock('@/stores/agents', () => ({
  useAgentsStore: {
    getState: () => agentsState,
  },
}));

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
  getEmptyFinalDiagnostic: (...args: unknown[]) => hostApiFetchMock(...args),
  getSessionBackendActivity: (...args: unknown[]) => getSessionBackendActivityMock(...args),
  recoverStaleSessionAfterEmptyFinal: (...args: unknown[]) => hostApiFetchMock(...args),
}));

vi.mock('@/lib/ui-state-persistence', () => ({
  flushUiStateSync: vi.fn(async () => undefined),
  hydrateUiStateFromDisk: vi.fn(async () => undefined),
}));

const SESSION_KEY = 'agent:main:session-1782962028099';
const PARENT_RUN_ID = '92fd60c7-0000-4000-8000-0000000037f3';
const CHILD_SESSION_KEY = 'agent:main:subagent:49410220-b603-4eaf-86d0-8ca787d76574';
const ANNOUNCE_RUN_ID = `announce:v1:${CHILD_SESSION_KEY}:child-run-1`;

describe('chat announce run events', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useRealTimers();
    window.localStorage.clear();
    gatewayRpcMock.mockReset();
    hostApiFetchMock.mockReset();
    getSessionBackendActivityMock.mockReset();
    hostApiFetchMock.mockResolvedValue({ success: false, messages: [], error: 'local miss' });
    getSessionBackendActivityMock.mockResolvedValue({
      success: true,
      session: {
        sessionKey: SESSION_KEY,
        status: 'completed',
        processing: false,
        hasTrackedUserRun: false,
        activeRunIds: [],
      },
      background: {
        hasBackgroundProcessing: false,
        processingSessionKeys: [],
      },
    });
    agentsState.agents = [];
  });

  it('streams announce deltas while the parent run id is still active', async () => {
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: SESSION_KEY,
      currentAgentId: 'main',
      sessions: [{ key: SESSION_KEY }],
      messages: [{ role: 'user', id: 'user-1', content: 'make a ppt' }],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: true,
      activeRunId: PARENT_RUN_ID,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: true,
      lastUserMessageAt: Date.now(),
      pendingToolImages: [],
      error: null,
      loading: false,
      thinkingLevel: null,
    });

    useChatStore.getState().handleChatEvent({
      state: 'delta',
      runId: ANNOUNCE_RUN_ID,
      sessionKey: SESSION_KEY,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'PPT is ready at /tmp/demo.pptx' }],
      },
    });

    const state = useChatStore.getState();
    expect(state.activeRunId).toBe(ANNOUNCE_RUN_ID);
    expect(state.streamingMessage).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'PPT is ready at /tmp/demo.pptx' }],
    });
    expect(state.sending).toBe(true);
    expect(state.pendingFinal).toBe(true);
  });

  it('processes announce finals while the parent run id is still active', async () => {
    vi.useFakeTimers();
    const { useChatStore } = await import('@/stores/chat');
    const loadHistorySpy = vi.spyOn(useChatStore.getState(), 'loadHistory').mockResolvedValue();

    useChatStore.setState({
      currentSessionKey: SESSION_KEY,
      currentAgentId: 'main',
      sessions: [{ key: SESSION_KEY }],
      messages: [{ role: 'user', id: 'user-1', content: 'make a ppt' }],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: true,
      activeRunId: PARENT_RUN_ID,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: true,
      lastUserMessageAt: Date.now(),
      pendingToolImages: [],
      error: null,
      loading: false,
      thinkingLevel: null,
    });

    useChatStore.getState().handleChatEvent({
      state: 'final',
      runId: ANNOUNCE_RUN_ID,
      sessionKey: SESSION_KEY,
      message: {
        role: 'assistant',
        id: 'announce-final-1',
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'PPT is ready at /tmp/demo.pptx' }],
      },
    });

    const state = useChatStore.getState();
    expect(state.sending).toBe(false);
    expect(state.activeRunId).toBeNull();
    expect(state.pendingFinal).toBe(false);
    expect(loadHistorySpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(800);
    expect(loadHistorySpy).toHaveBeenCalledWith(true, { force: true });
    vi.useRealTimers();
  });

  it('clears thinking state after a delegated announce final with a visible answer', async () => {
    vi.useFakeTimers();
    const { useChatStore } = await import('@/stores/chat');
    const loadHistorySpy = vi.spyOn(useChatStore.getState(), 'loadHistory').mockResolvedValue();
    const lastUserMessageAt = Date.now();

    useChatStore.setState({
      currentSessionKey: SESSION_KEY,
      currentAgentId: 'main',
      sessions: [{ key: SESSION_KEY }],
      messages: [
        { role: 'user', id: 'user-1', content: 'make a ppt', timestamp: lastUserMessageAt },
        {
          role: 'assistant',
          id: 'spawn-assistant',
          content: [{ type: 'tool_use', id: 'spawn-1', name: 'sessions_spawn', input: { taskName: 'ppt' } }],
          stopReason: 'toolUse',
        },
        {
          role: 'toolResult',
          toolCallId: 'spawn-1',
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'accepted',
              childSessionKey: CHILD_SESSION_KEY,
              runId: 'child-run-1',
            }),
          }],
        },
        {
          role: 'assistant',
          id: 'parent-wait',
          content: 'PPT is being generated in the background…',
          stopReason: 'stop',
        },
      ],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: true,
      activeRunId: PARENT_RUN_ID,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: true,
      lastUserMessageAt,
      pendingToolImages: [],
      error: null,
      loading: false,
      thinkingLevel: null,
      gatewayBackgroundActivity: {
        hasBackgroundProcessing: false,
        processingSessionKeys: [],
      },
      sessionBackendActivity: {
        sessionKey: SESSION_KEY,
        status: 'idle',
        processing: false,
        hasTrackedUserRun: false,
        activeRunIds: [],
      },
    });

    useChatStore.getState().handleChatEvent({
      state: 'final',
      runId: ANNOUNCE_RUN_ID,
      sessionKey: SESSION_KEY,
      message: {
        role: 'assistant',
        id: 'announce-final-1',
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'PPT is ready at /tmp/demo.pptx' }],
      },
    });

    const state = useChatStore.getState();
    await vi.advanceTimersByTimeAsync(800);
    expect(loadHistorySpy).toHaveBeenCalledWith(true, { force: true });
    expect(state.sending).toBe(false);
    expect(state.activeRunId).toBeNull();
    expect(state.pendingFinal).toBe(false);
    expect(state.messages.some((message) => (
      message.role === 'assistant'
      && JSON.stringify(message.content).includes('PPT is ready at /tmp/demo.pptx')
    ))).toBe(true);
    vi.useRealTimers();
  });

  it('clears thinking state after announce final even without stopReason', async () => {
    const { useChatStore } = await import('@/stores/chat');
    vi.spyOn(useChatStore.getState(), 'loadHistory').mockResolvedValue();
    const lastUserMessageAt = Date.now();

    useChatStore.setState({
      currentSessionKey: SESSION_KEY,
      currentAgentId: 'main',
      sessions: [{ key: SESSION_KEY }],
      messages: [
        { role: 'user', id: 'user-1', content: 'make a ppt', timestamp: lastUserMessageAt },
        {
          role: 'assistant',
          id: 'spawn-assistant',
          content: [{ type: 'tool_use', id: 'spawn-1', name: 'sessions_spawn', input: { taskName: 'ppt' } }],
          stopReason: 'toolUse',
        },
        {
          role: 'toolResult',
          toolCallId: 'spawn-1',
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'accepted',
              childSessionKey: CHILD_SESSION_KEY,
              runId: 'child-run-1',
            }),
          }],
        },
        {
          role: 'assistant',
          id: 'parent-wait',
          content: 'PPT is being generated in the background…',
          stopReason: 'stop',
        },
      ],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: true,
      activeRunId: PARENT_RUN_ID,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: true,
      lastUserMessageAt,
      pendingToolImages: [],
      error: null,
      loading: false,
      thinkingLevel: null,
      gatewayBackgroundActivity: {
        hasBackgroundProcessing: false,
        processingSessionKeys: [],
      },
      sessionBackendActivity: {
        sessionKey: SESSION_KEY,
        status: 'idle',
        processing: false,
        hasTrackedUserRun: false,
        activeRunIds: [],
      },
    });

    useChatStore.getState().handleChatEvent({
      state: 'final',
      runId: ANNOUNCE_RUN_ID,
      sessionKey: SESSION_KEY,
      message: {
        role: 'assistant',
        id: 'announce-final-1',
        content: [{ type: 'text', text: 'PPT is ready at /tmp/demo.pptx' }],
      },
    });

    const state = useChatStore.getState();
    expect(state.sending).toBe(false);
    expect(state.activeRunId).toBeNull();
    expect(state.pendingFinal).toBe(false);
    expect(state.streamingMessage).toBeNull();
  });

  it('does not mark the child completed on announce delta', async () => {
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: SESSION_KEY,
      announcedChildSessionKeys: [],
      messages: [{ role: 'user', id: 'user-1', content: 'make a ppt' }],
      sending: true,
      activeRunId: PARENT_RUN_ID,
      pendingFinal: true,
      lastUserMessageAt: Date.now(),
    });

    useChatStore.getState().handleChatEvent({
      state: 'delta',
      runId: ANNOUNCE_RUN_ID,
      sessionKey: SESSION_KEY,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'PPT is ready at /tmp/demo.pptx' }],
      },
    });

    expect(useChatStore.getState().announcedChildSessionKeys).toEqual([]);
  });

  it('marks the child completed on announce final', async () => {
    const { useChatStore } = await import('@/stores/chat');
    vi.spyOn(useChatStore.getState(), 'loadHistory').mockResolvedValue();

    useChatStore.setState({
      currentSessionKey: SESSION_KEY,
      announcedChildSessionKeys: [],
      messages: [{ role: 'user', id: 'user-1', content: 'make a ppt' }],
      sending: true,
      activeRunId: PARENT_RUN_ID,
      pendingFinal: true,
      lastUserMessageAt: Date.now(),
    });

    useChatStore.getState().handleChatEvent({
      state: 'final',
      runId: ANNOUNCE_RUN_ID,
      sessionKey: SESSION_KEY,
      message: {
        role: 'assistant',
        id: 'announce-final-1',
        content: [{ type: 'text', text: 'PPT is ready at /tmp/demo.pptx' }],
      },
    });

    expect(useChatStore.getState().announcedChildSessionKeys).toEqual([CHILD_SESSION_KEY]);
  });

  it('preserves announce final when history-local lags behind the renderer transcript', async () => {
    vi.useFakeTimers();
    const { useChatStore } = await import('@/stores/chat');
    const lastUserMessageAt = Date.now();
    const laggingHistory = [
      { role: 'user', id: 'user-1', content: 'make a ppt', timestamp: lastUserMessageAt },
      {
        role: 'assistant',
        id: 'spawn-assistant',
        content: [{ type: 'tool_use', id: 'spawn-1', name: 'sessions_spawn', input: { taskName: 'ppt' } }],
        stopReason: 'toolUse',
      },
      {
        role: 'toolResult',
        toolCallId: 'spawn-1',
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'accepted',
            childSessionKey: CHILD_SESSION_KEY,
            runId: 'child-run-1',
          }),
        }],
      },
      {
        role: 'assistant',
        id: 'parent-wait',
        content: 'PPT is being generated in the background…',
        stopReason: 'stop',
      },
    ];

    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (String(path).includes('/api/sessions/history-local')) {
        return { success: true, messages: laggingHistory };
      }
      return { success: false, messages: [], error: 'local miss' };
    });

    useChatStore.setState({
      currentSessionKey: SESSION_KEY,
      currentAgentId: 'main',
      sessions: [{ key: SESSION_KEY }],
      messages: laggingHistory as never[],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: true,
      activeRunId: PARENT_RUN_ID,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: true,
      lastUserMessageAt,
      pendingToolImages: [],
      error: null,
      loading: false,
      thinkingLevel: null,
      gatewayBackgroundActivity: {
        hasBackgroundProcessing: false,
        processingSessionKeys: [CHILD_SESSION_KEY],
      },
      sessionBackendActivity: {
        sessionKey: SESSION_KEY,
        status: 'idle',
        processing: false,
        hasTrackedUserRun: false,
        activeRunIds: [],
      },
    });

    useChatStore.getState().handleChatEvent({
      state: 'final',
      runId: ANNOUNCE_RUN_ID,
      sessionKey: SESSION_KEY,
      message: {
        role: 'assistant',
        id: 'announce-final-1',
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'PPT is ready at /tmp/demo.pptx' }],
      },
    });

    expect(useChatStore.getState().sending).toBe(false);

    await vi.advanceTimersByTimeAsync(800);
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();

    const state = useChatStore.getState();
    expect(state.messages.some((message) => (
      message.role === 'assistant'
      && JSON.stringify(message.content).includes('PPT is ready at /tmp/demo.pptx')
    ))).toBe(true);
    expect(state.sending).toBe(false);
    vi.useRealTimers();
  });

  it('defers abort history reload past the abort quiet window', async () => {
    vi.useFakeTimers();
    const { useChatStore } = await import('@/stores/chat');

    hostApiFetchMock.mockResolvedValue({
      success: true,
      messages: [{ role: 'assistant', id: 'hist-1', content: 'synced answer' }],
    });

    useChatStore.setState({
      currentSessionKey: SESSION_KEY,
      currentAgentId: 'main',
      sessions: [{ key: SESSION_KEY }],
      messages: [{ role: 'user', id: 'user-1', content: 'make a ppt' }],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: true,
      activeRunId: PARENT_RUN_ID,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: true,
      lastUserMessageAt: Date.now(),
      pendingToolImages: [],
      error: null,
      loading: false,
      thinkingLevel: null,
    });

    const loadHistorySpy = vi.spyOn(useChatStore.getState(), 'loadHistory');

    await useChatStore.getState().abortRun();

    expect(loadHistorySpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_100);

    expect(loadHistorySpy).toHaveBeenCalledWith(true, { force: true });
  });
});
