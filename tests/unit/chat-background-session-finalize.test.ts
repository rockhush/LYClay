import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { gatewayRpcMock } = vi.hoisted(() => ({
  gatewayRpcMock: vi.fn(),
}));

vi.mock('@/stores/gateway', () => ({
  useGatewayStore: {
    getState: () => ({
      rpc: gatewayRpcMock,
      status: { gatewayReady: true },
    }),
  },
}));

vi.mock('@/stores/agents', () => ({
  useAgentsStore: {
    getState: () => ({ agents: [] }),
  },
}));

vi.mock('@/stores/workspaces', () => ({
  useWorkspacesStore: {
    getState: () => ({
      currentWorkspaceId: null,
      currentWorkspacePath: null,
      setCurrentWorkspace: vi.fn(),
    }),
  },
}));

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: vi.fn(),
}));

vi.mock('@/lib/ui-state-persistence', () => ({
  hydrateUiStateFromDisk: vi.fn().mockResolvedValue(undefined),
  persistUiStateSoon: vi.fn(),
}));

function makeStreamingState(overrides: Record<string, unknown> = {}) {
  return {
    activeRunId: 'run-bg',
    streamingText: '',
    streamingMessage: { role: 'assistant', content: 'partial…' },
    streamingTools: [],
    pendingFinal: false,
    lastUserMessageAt: Date.now(),
    pendingToolImages: [],
    runAborted: false,
    sending: true,
    messagesSnapshot: [{ role: 'user', content: 'background question' }],
    ...overrides,
  };
}

describe('background session run finalization', () => {
  beforeEach(() => {
    vi.resetModules();
    window.localStorage.clear();
    gatewayRpcMock.mockReset();
    gatewayRpcMock.mockResolvedValue({ messages: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('clears the saved streaming state when a background run finishes with a real answer', async () => {
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:visible',
      activeRunId: null,
      sending: false,
      sessionStreamingStates: {
        'agent:main:background': makeStreamingState(),
      },
    });

    useChatStore.getState().handleChatEvent({
      sessionKey: 'agent:main:background',
      runId: 'run-bg',
      state: 'final',
      message: { role: 'assistant', content: 'Here is the complete answer.' },
    });

    const saved = useChatStore.getState().sessionStreamingStates['agent:main:background'];
    expect(saved.sending).toBe(false);
    expect(saved.activeRunId).toBeNull();
    expect(saved.streamingMessage).toBeNull();
    expect(saved.messagesSnapshot).toEqual([]);
  });

  it('does not mutate the visible session state when a background event arrives', async () => {
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:visible',
      activeRunId: null,
      sending: false,
      streamingMessage: null,
      sessionStreamingStates: {
        'agent:main:background': makeStreamingState(),
      },
    });

    useChatStore.getState().handleChatEvent({
      sessionKey: 'agent:main:background',
      runId: 'run-bg',
      state: 'final',
      message: { role: 'assistant', content: 'Here is the complete answer.' },
    });

    const state = useChatStore.getState();
    expect(state.sending).toBe(false);
    expect(state.activeRunId).toBeNull();
    expect(state.streamingMessage).toBeNull();
  });

  it('keeps the background session streaming for non-terminal (tool-only) events', async () => {
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:visible',
      activeRunId: null,
      sending: false,
      sessionStreamingStates: {
        'agent:main:background': makeStreamingState(),
      },
    });

    useChatStore.getState().handleChatEvent({
      sessionKey: 'agent:main:background',
      runId: 'run-bg',
      state: 'final',
      message: { role: 'toolresult', content: 'tool output', toolCallId: 't1' },
    });

    const saved = useChatStore.getState().sessionStreamingStates['agent:main:background'];
    expect(saved.sending).toBe(true);
    expect(saved.activeRunId).toBe('run-bg');
  });

  it('marks runAborted when a background run is aborted', async () => {
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:visible',
      activeRunId: null,
      sending: false,
      sessionStreamingStates: {
        'agent:main:background': makeStreamingState(),
      },
    });

    useChatStore.getState().handleChatEvent({
      sessionKey: 'agent:main:background',
      runId: 'run-bg',
      state: 'aborted',
    });

    const saved = useChatStore.getState().sessionStreamingStates['agent:main:background'];
    expect(saved.sending).toBe(false);
    expect(saved.activeRunId).toBeNull();
    expect(saved.runAborted).toBe(true);
  });
});
