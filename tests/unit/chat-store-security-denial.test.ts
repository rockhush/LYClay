import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { gatewayRpcMock, hostApiFetchMock, agentsState } = vi.hoisted(() => ({
  gatewayRpcMock: vi.fn(),
  hostApiFetchMock: vi.fn(),
  agentsState: {
    agents: [] as Array<Record<string, unknown>>,
  },
}));

vi.mock('@/stores/gateway', () => ({
  useGatewayStore: {
    getState: () => ({
      status: { state: 'running', port: 18789, gatewayReady: true },
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
}));

vi.mock('@/lib/ui-state-persistence', () => ({
  hydrateUiStateFromDisk: vi.fn(),
  startUiStateSync: vi.fn(),
  scheduleUiStateSync: vi.fn(),
  flushUiStateSync: vi.fn(),
}));

function seedChatStore(useChatStore: typeof import('@/stores/chat').useChatStore) {
  useChatStore.setState({
    currentSessionKey: 'agent:main:main',
    currentAgentId: 'main',
    sessions: [{ key: 'agent:main:main' }],
    messages: [],
    sessionLabels: {},
    sessionLastActivity: {},
    sending: false,
    activeRunId: null,
    streamingText: '',
    streamingMessage: null,
    streamingTools: [],
    pendingFinal: false,
    lastUserMessageAt: null,
    pendingToolImages: [],
    error: null,
    runError: null,
    securityCancelNotice: null,
    loading: false,
    thinkingLevel: null,
  });
}

describe('useChatStore security denial handling', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    window.localStorage.clear();
    gatewayRpcMock.mockReset();
    hostApiFetchMock.mockReset();
    agentsState.agents = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('treats network confirmation denial from chat.send as cancellation, not a red chat error', async () => {
    gatewayRpcMock.mockRejectedValueOnce(new Error('Error: Network access denied: 10.0.1.83'));

    const { useChatStore } = await import('@/stores/chat');
    seedChatStore(useChatStore);

    await useChatStore.getState().sendMessage('访问 http://10.0.1.83:8009/api/check-token');

    const state = useChatStore.getState();
    expect(state.error).toBeNull();
    expect(state.runError).toBeNull();
    expect(state.securityCancelNotice).toBeTruthy();
    expect(state.sending).toBe(false);
    expect(state.activeRunId).toBeNull();
    expect(state.streamingMessage).toBeNull();
    expect(state.streamingTools).toEqual([]);
  });

  it('treats local file denial from runtime error events as cancellation', async () => {
    const { useChatStore } = await import('@/stores/chat');
    seedChatStore(useChatStore);
    useChatStore.setState({
      sending: true,
      activeRunId: 'run-denied',
      lastUserMessageAt: Date.now(),
      streamingMessage: { role: 'assistant', content: 'partial' },
      streamingTools: [{ id: 'read-file', name: 'read', status: 'running', updatedAt: Date.now() }],
    });

    useChatStore.getState().handleChatEvent({
      state: 'error',
      runId: 'run-denied',
      sessionKey: 'agent:main:main',
      error: 'Error: Local file path access denied by user: D:\\测试2\\hello.txt',
    });

    const state = useChatStore.getState();
    expect(state.error).toBeNull();
    expect(state.runError).toBeNull();
    expect(state.securityCancelNotice).toContain('D:\\测试2\\hello.txt');
    expect(state.sending).toBe(false);
    expect(state.activeRunId).toBeNull();
    expect(state.streamingMessage).toBeNull();
    expect(state.streamingTools).toEqual([]);
  });

  it('treats assistant final error denials as cancellation', async () => {
    const { useChatStore } = await import('@/stores/chat');
    seedChatStore(useChatStore);
    useChatStore.setState({
      sending: true,
      activeRunId: 'run-final-denied',
      lastUserMessageAt: Date.now(),
    });

    useChatStore.getState().handleChatEvent({
      state: 'final',
      runId: 'run-final-denied',
      sessionKey: 'agent:main:main',
      message: {
        role: 'assistant',
        id: 'assistant-denied',
        content: [],
        stopReason: 'error',
        errorMessage: 'Error: Network access denied: 10.0.1.83',
      },
    });

    const state = useChatStore.getState();
    expect(state.error).toBeNull();
    expect(state.runError).toBeNull();
    expect(state.securityCancelNotice).toBeTruthy();
    expect(state.sending).toBe(false);
    expect(state.activeRunId).toBeNull();
    expect(state.pendingFinal).toBe(false);
  });
});
