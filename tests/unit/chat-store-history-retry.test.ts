import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { gatewayRpcMock, agentsState, hostApiFetchMock } = vi.hoisted(() => ({
  gatewayRpcMock: vi.fn(),
  agentsState: {
    agents: [] as Array<Record<string, unknown>>,
  },
  hostApiFetchMock: vi.fn(),
}));

vi.mock('@/stores/gateway', () => ({
  useGatewayStore: {
    getState: () => ({
      status: { state: 'running', port: 18789, connectedAt: Date.now() },
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

describe('useChatStore startup history retry', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    window.localStorage.clear();
    agentsState.agents = [];
    gatewayRpcMock.mockReset();
    hostApiFetchMock.mockReset();
    hostApiFetchMock.mockResolvedValue({ success: false, messages: [], error: 'local miss' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses the longer timeout only for the initial foreground history load', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: false,
      aborting: false,
      activeRunId: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      error: null,
      loading: false,
      thinkingLevel: null,
    });

    gatewayRpcMock
      .mockResolvedValueOnce({
        messages: [{ role: 'assistant', content: 'first load', timestamp: 1000 }],
      })
      .mockResolvedValueOnce({
        messages: [{ role: 'assistant', content: 'quiet refresh', timestamp: 1001 }],
      });

    await useChatStore.getState().loadHistory(false);
    vi.advanceTimersByTime(1_000);
    await useChatStore.getState().loadHistory(true);

    expect(gatewayRpcMock).toHaveBeenNthCalledWith(
      1,
      'chat.history',
      { sessionKey: 'agent:main:main', limit: 200 },
      30_000,
    );
    expect(gatewayRpcMock).toHaveBeenNthCalledWith(
      2,
      'chat.history',
      { sessionKey: 'agent:main:main', limit: 200 },
      undefined,
    );
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 129_000);
    setTimeoutSpy.mockRestore();
  });

  it('forces the internal final-message reload through the quiet history cooldown', async () => {
    const { useChatStore } = await import('@/stores/chat');
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
      loading: false,
      thinkingLevel: null,
    });

    gatewayRpcMock
      .mockResolvedValueOnce({
        messages: [{ role: 'user', content: 'hello', id: 'u1', timestamp: 1000 }],
      })
      .mockResolvedValueOnce({
        messages: [
          { role: 'user', content: 'hello', id: 'u1', timestamp: 1000 },
          { role: 'assistant', content: 'Real answer', id: 'a2', timestamp: 1001 },
        ],
      });

    await useChatStore.getState().loadHistory(true);
    useChatStore.setState({
      sending: true,
      activeRunId: 'run-internal',
      streamingText: 'NO_REPLY',
      streamingMessage: { role: 'assistant', content: 'NO_REPLY' },
    });

    useChatStore.getState().handleChatEvent({
      state: 'final',
      runId: 'run-internal',
      sessionKey: 'agent:main:main',
      message: { role: 'assistant', content: 'NO_REPLY', id: 'a1' },
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(gatewayRpcMock).toHaveBeenCalledTimes(2);
    expect(useChatStore.getState().messages.map((message) => message.content)).toEqual([
      'hello',
      'Real answer',
    ]);
    expect(useChatStore.getState().sending).toBe(false);
    expect(useChatStore.getState().activeRunId).toBeNull();
  });

  it('finalizes an active send when quiet local history contains the terminal assistant message', async () => {
    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [{ role: 'user', content: 'hello', id: 'u1', timestamp: 1000 }],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: true,
      activeRunId: 'run-history-final',
      streamingText: '',
      streamingMessage: { role: 'assistant', content: [{ type: 'text', text: 'partial' }] },
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: 1000,
      pendingToolImages: [],
      error: null,
      loading: false,
      thinkingLevel: null,
    });

    hostApiFetchMock.mockResolvedValueOnce({
      success: true,
      messages: [
        { role: 'user', content: 'hello', id: 'u1', timestamp: 1000 },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'terminal answer' }],
          id: 'a1',
          timestamp: 1001,
          stopReason: 'stop',
        },
      ],
    });

    await useChatStore.getState().loadHistory(true, { force: true });

    expect(useChatStore.getState().messages.map((message) => message.content)).toEqual([
      'hello',
      [{ type: 'text', text: 'terminal answer' }],
    ]);
    expect(useChatStore.getState().sending).toBe(false);
    expect(useChatStore.getState().activeRunId).toBeNull();
    expect(useChatStore.getState().pendingFinal).toBe(false);
    expect(useChatStore.getState().streamingMessage).toBeNull();
  });

  it('keeps non-startup foreground loading safety timeout at 15 seconds', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const { useChatStore } = await import('@/stores/chat');
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
      loading: false,
      thinkingLevel: null,
    });

    gatewayRpcMock
      .mockResolvedValueOnce({
        messages: [{ role: 'assistant', content: 'first load', timestamp: 1000 }],
      })
      .mockResolvedValueOnce({
        messages: [{ role: 'assistant', content: 'second foreground load', timestamp: 1001 }],
      });

    await useChatStore.getState().loadHistory(false);
    setTimeoutSpy.mockClear();
    useChatStore.setState({ messages: [] });
    await useChatStore.getState().loadHistory(false);

    expect(gatewayRpcMock).toHaveBeenNthCalledWith(
      2,
      'chat.history',
      { sessionKey: 'agent:main:main', limit: 200 },
      undefined,
    );
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 15_000);
    setTimeoutSpy.mockRestore();
  });

  it('does not burn the first-load retry path when the first attempt becomes stale', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }, { key: 'agent:main:other' }],
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
      loading: false,
      thinkingLevel: null,
    });

    let resolveFirstAttempt: ((value: { messages: Array<{ role: string; content: string; timestamp: number }> }) => void) | null = null;
    gatewayRpcMock
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveFirstAttempt = resolve;
      }))
      .mockResolvedValueOnce({
        messages: [{ role: 'assistant', content: 'restored after retry', timestamp: 1002 }],
      });

    const firstLoad = useChatStore.getState().loadHistory(false);
    useChatStore.setState({
      currentSessionKey: 'agent:main:other',
      messages: [{ role: 'assistant', content: 'other session', timestamp: 1001 }],
    });
    resolveFirstAttempt?.({
      messages: [{ role: 'assistant', content: 'stale original payload', timestamp: 1000 }],
    });
    await firstLoad;

    expect(gatewayRpcMock).not.toHaveBeenCalled();
    expect(useChatStore.getState().currentSessionKey).toBe('agent:main:other');
    expect(useChatStore.getState().messages.map((message) => message.content)).toEqual(['other session']);
    expect(warnSpy).not.toHaveBeenCalledWith(
      '[chat.history] startup retry exhausted',
      expect.anything(),
    );
    warnSpy.mockRestore();
  });

  it('stops retrying once the user switches sessions mid-load', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }, { key: 'agent:main:other' }],
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
      loading: false,
      thinkingLevel: null,
    });

    gatewayRpcMock.mockImplementationOnce(async () => {
      useChatStore.setState({
        currentSessionKey: 'agent:main:other',
        messages: [{ role: 'assistant', content: 'other session', timestamp: 1001 }],
        loading: false,
      });
      throw new Error('RPC timeout: chat.history');
    });

    await useChatStore.getState().loadHistory(false);

    expect(gatewayRpcMock).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().currentSessionKey).toBe('agent:main:other');
    expect(useChatStore.getState().messages.map((message) => message.content)).toEqual(['other session']);
    expect(useChatStore.getState().error).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('refreshes local transcript during an active send before the first stream delta', async () => {
    vi.setSystemTime(new Date('2026-05-18T05:10:57.000Z'));
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { useChatStore } = await import('@/stores/chat');

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
      loading: false,
      thinkingLevel: null,
      reasoningMode: 'fast',
      runAborted: false,
    });

    gatewayRpcMock.mockImplementation(async (method: string) => {
      if (method === 'chat.send') return { runId: 'run-local-progress' };
      if (method === 'sessions.patch') return {};
      return {};
    });
    hostApiFetchMock.mockResolvedValue({
      success: true,
      messages: [
        {
          role: 'user',
          id: 'user-from-transcript',
          timestamp: Date.now() / 1000,
          content: 'How do I request annual leave?',
        },
        {
          role: 'assistant',
          id: 'assistant-tool-plan',
          timestamp: Date.now() / 1000 + 1,
          content: [
            { type: 'thinking', thinking: 'Checking the leave flow.' },
            { type: 'toolCall', id: 'call-1', name: 'memory_search', arguments: { query: 'annual leave' } },
          ],
        },
      ],
    });

    await useChatStore.getState().sendMessage('How do I request annual leave?');
    expect(useChatStore.getState().activeRunId).toBe('run-local-progress');
    expect(useChatStore.getState().messages).toHaveLength(1);

    const expectedHistoryUrl = '/api/sessions/history-local?sessionKey=agent%3Amain%3Asession-1779081057000';
    const historyLocalCallCount = () => hostApiFetchMock.mock.calls.filter(
      ([url]) => url === expectedHistoryUrl,
    ).length;

    await vi.advanceTimersByTimeAsync(14_999);
    expect(historyLocalCallCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(1);

    expect(historyLocalCallCount()).toBe(1);
    expect(useChatStore.getState().messages.map((message) => message.id)).toEqual([
      'user-from-transcript',
      'assistant-tool-plan',
    ]);
    expect(infoSpy).toHaveBeenCalledWith(
      '[perf:chat-run-ui]',
      'transcript.first_progress',
      expect.objectContaining({
        runId: 'run-local-progress',
        source: 'local-history',
        assistantCount: 1,
      }),
    );
    infoSpy.mockRestore();
  });
});
