import { beforeEach, describe, expect, it, vi } from 'vitest';

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
}));

vi.mock('@/lib/ui-state-persistence', () => ({
  flushUiStateSync: vi.fn(async () => undefined),
  hydrateUiStateFromDisk: vi.fn(async () => undefined),
}));

describe('chat abort run', () => {
  beforeEach(() => {
    vi.resetModules();
    window.localStorage.clear();
    gatewayRpcMock.mockReset();
    hostApiFetchMock.mockReset();
    agentsState.agents = [];
    gatewayRpcMock.mockResolvedValue({ ok: true });
  });

  it('ignores late delta events after the user aborts a run', async () => {
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: true,
      activeRunId: 'run-abort-me',
      streamingText: '',
      streamingMessage: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Partial output' }],
      },
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: Date.now(),
      pendingToolImages: [],
      error: null,
      loading: false,
      thinkingLevel: null,
      runAborted: false,
    });

    await useChatStore.getState().abortRun();

    expect(useChatStore.getState().sending).toBe(false);
    expect(useChatStore.getState().activeRunId).toBeNull();
    expect(useChatStore.getState().runAborted).toBe(true);
    expect(gatewayRpcMock).toHaveBeenCalledWith(
      'sessions.abort',
      expect.objectContaining({
        key: 'agent:main:main',
        runId: 'run-abort-me',
      }),
      expect.anything(),
    );

    useChatStore.getState().handleChatEvent({
      state: 'delta',
      runId: 'run-abort-me',
      sessionKey: 'agent:main:main',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'This should not appear after abort.' }],
      },
    });

    expect(useChatStore.getState().streamingMessage).toBeNull();
    expect(useChatStore.getState().sending).toBe(false);
  });
});
