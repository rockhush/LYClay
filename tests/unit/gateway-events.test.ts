import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  hostApiFetchMock,
  subscribeHostEventMock,
  chatLoadHistoryMock,
  chatLoadSessionsMock,
  chatHandleEventMock,
  chatHandleGatewayRunCompletedMock,
  chatSetStateMock,
  chatStateMock,
} = vi.hoisted(() => ({
  hostApiFetchMock: vi.fn(),
  subscribeHostEventMock: vi.fn(),
  chatLoadHistoryMock: vi.fn(),
  chatLoadSessionsMock: vi.fn(),
  chatHandleEventMock: vi.fn(),
  chatHandleGatewayRunCompletedMock: vi.fn(),
  chatSetStateMock: vi.fn(),
  chatStateMock: {
    currentSessionKey: 'agent:main:main',
    activeRunId: 'run-1',
    sending: true,
    sessions: [{ key: 'agent:main:main' }],
    sessionStreamingStates: {},
    loadHistory: vi.fn(),
    loadSessions: vi.fn(),
    handleChatEvent: vi.fn(),
    handleGatewayRunCompleted: vi.fn(),
  },
}));

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
}));

vi.mock('@/lib/host-events', () => ({
  subscribeHostEvent: (...args: unknown[]) => subscribeHostEventMock(...args),
}));

vi.mock('@/stores/chat', () => ({
  useChatStore: {
    getState: () => chatStateMock,
    setState: chatSetStateMock,
  },
}));

vi.mock('../../src/stores/chat', () => ({
  useChatStore: {
    getState: () => chatStateMock,
    setState: chatSetStateMock,
  },
}));

describe('gateway store event wiring', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.clearAllMocks();
    chatStateMock.currentSessionKey = 'agent:main:main';
    chatStateMock.activeRunId = 'run-1';
    chatStateMock.sending = true;
    chatStateMock.sessions = [{ key: 'agent:main:main' }];
    chatStateMock.sessionStreamingStates = {};
    chatStateMock.loadHistory = chatLoadHistoryMock;
    chatStateMock.loadSessions = chatLoadSessionsMock;
    chatStateMock.handleChatEvent = chatHandleEventMock;
    chatStateMock.handleGatewayRunCompleted = chatHandleGatewayRunCompletedMock;
  });

  it('subscribes to host events through subscribeHostEvent on init', async () => {
    hostApiFetchMock.mockResolvedValueOnce({ state: 'running', port: 18789 });

    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useGatewayStore } = await import('@/stores/gateway');
    await useGatewayStore.getState().init();

    expect(subscribeHostEventMock).toHaveBeenCalledWith('gateway:status', expect.any(Function));
    expect(subscribeHostEventMock).toHaveBeenCalledWith('gateway:error', expect.any(Function));
    expect(subscribeHostEventMock).toHaveBeenCalledWith('gateway:notification', expect.any(Function));
    expect(subscribeHostEventMock).toHaveBeenCalledWith('gateway:chat-message', expect.any(Function));
    expect(subscribeHostEventMock).toHaveBeenCalledWith('session:updated', expect.any(Function));
    expect(subscribeHostEventMock).toHaveBeenCalledWith('gateway:channel-status', expect.any(Function));

    handlers.get('gateway:status')?.({ state: 'stopped', port: 18789 });
    await Promise.resolve();
    expect(useGatewayStore.getState().status.state).toBe('stopped');
    await vi.waitFor(() => {
      expect(chatHandleEventMock).toHaveBeenCalledWith({
        state: 'aborted',
        runId: 'run-1',
        sessionKey: 'agent:main:main',
        reason: 'gateway-stopped',
      });
    });
  });

  it('clears orphaned chat sending state on gateway interruption even without an active run id', async () => {
    hostApiFetchMock.mockResolvedValueOnce({ state: 'running', port: 18789 });

    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    chatHandleEventMock.mockClear();
    chatSetStateMock.mockClear();

    const { useGatewayStore } = await import('@/stores/gateway');
    await useGatewayStore.getState().init();

    handlers.get('gateway:status')?.({ state: 'reconnecting', port: 18789 });

    await vi.waitFor(() => {
      expect(chatSetStateMock).toHaveBeenCalledWith(expect.any(Function));
    });
    const patch = chatSetStateMock.mock.calls.at(-1)?.[0]({
      currentSessionKey: 'agent:main:main',
      activeRunId: null,
      activeTool: null,
      sending: true,
      pendingFinal: true,
      messages: [],
      sessionStreamingStates: {},
    });
    expect(patch).toMatchObject({
      sending: false,
      activeRunId: null,
      activeTool: null,
      pendingFinal: false,
      runAborted: true,
      runError: 'Run interrupted because the Gateway restarted.',
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
    });
    expect(patch.sessionStreamingStates['agent:main:main']).toMatchObject({
      sending: false,
      activeRunId: null,
      pendingFinal: false,
      runAborted: true,
      runError: 'Run interrupted because the Gateway restarted.',
    });
  });

  it('propagates gatewayReady field from status events', async () => {
    hostApiFetchMock.mockResolvedValueOnce({ state: 'running', port: 18789, gatewayReady: false });

    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useGatewayStore } = await import('@/stores/gateway');
    await useGatewayStore.getState().init();

    // Initially gatewayReady=false from the status fetch
    expect(useGatewayStore.getState().status.gatewayReady).toBe(false);

    // Simulate gateway.ready event setting gatewayReady=true
    handlers.get('gateway:status')?.({ state: 'running', port: 18789, gatewayReady: true });
    expect(useGatewayStore.getState().status.gatewayReady).toBe(true);
  });

  it('treats undefined gatewayReady as ready for backwards compatibility', async () => {
    hostApiFetchMock.mockResolvedValueOnce({ state: 'running', port: 18789 });

    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useGatewayStore } = await import('@/stores/gateway');
    await useGatewayStore.getState().init();

    const status = useGatewayStore.getState().status;
    // gatewayReady is undefined (old gateway version) - should be treated as ready
    expect(status.gatewayReady).toBeUndefined();
    expect(status.state === 'running' && status.gatewayReady !== false).toBe(true);
  });

  it('defers session list refresh from session.updated while a chat run is active', async () => {
    hostApiFetchMock.mockResolvedValue({ state: 'running', port: 18789 });

    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useGatewayStore } = await import('@/stores/gateway');
    await useGatewayStore.getState().init();

    handlers.get('session:updated')?.({ sessionKey: 'agent:main:main' });

    await vi.waitFor(() => {
      expect(chatLoadHistoryMock).toHaveBeenCalledWith(true, { force: true });
    });
    expect(chatLoadSessionsMock).not.toHaveBeenCalled();

    chatStateMock.sending = false;
    chatStateMock.activeRunId = null;
    await vi.waitFor(() => {
      expect(chatLoadSessionsMock).toHaveBeenCalledWith(true);
    }, { timeout: 2_000 });
  });

  it('flushes a deferred session list refresh after the active run completes', async () => {
    hostApiFetchMock.mockResolvedValue({ state: 'running', port: 18789 });

    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useGatewayStore } = await import('@/stores/gateway');
    await useGatewayStore.getState().init();

    handlers.get('session:updated')?.({ sessionKey: 'agent:main:main' });
    await vi.waitFor(() => {
      expect(chatLoadHistoryMock).toHaveBeenCalledWith(true, { force: true });
    });
    expect(chatLoadSessionsMock).not.toHaveBeenCalled();

    chatStateMock.sending = false;
    chatStateMock.activeRunId = null;
    handlers.get('gateway:notification')?.({
      method: 'agent',
      params: {
        runId: 'run-1',
        sessionKey: 'agent:main:main',
        stream: 'lifecycle',
        data: { phase: 'completed' },
      },
    });
    await vi.waitFor(() => {
      expect(chatHandleGatewayRunCompletedMock).toHaveBeenCalledWith('run-1', 'agent:main:main');
    });
    await vi.waitFor(() => {
      expect(chatLoadSessionsMock).toHaveBeenCalledWith(true);
    }, { timeout: 2_000 });
  });

  it('refreshes transcript on agent lifecycle phase=end without finalizing', async () => {
    hostApiFetchMock.mockResolvedValueOnce({ state: 'running', port: 18789 });

    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useGatewayStore } = await import('@/stores/gateway');
    await useGatewayStore.getState().init();

    handlers.get('gateway:notification')?.({
      method: 'agent',
      params: {
        runId: 'run-end',
        sessionKey: 'agent:main:main',
        data: { phase: 'end' },
      },
    });

    await vi.waitFor(() => {
      expect(chatLoadHistoryMock).toHaveBeenCalled();
    });
    expect(chatHandleGatewayRunCompletedMock).not.toHaveBeenCalled();
  });

  it('finalizes active runs on agent lifecycle phase=completed', async () => {
    hostApiFetchMock.mockResolvedValueOnce({ state: 'running', port: 18789 });

    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useGatewayStore } = await import('@/stores/gateway');
    await useGatewayStore.getState().init();

    handlers.get('gateway:notification')?.({
      method: 'agent',
      params: {
        runId: 'run-1',
        sessionKey: 'agent:main:main',
        stream: 'lifecycle',
        data: { phase: 'completed' },
      },
    });
    await vi.waitFor(() => {
      expect(chatHandleGatewayRunCompletedMock).toHaveBeenCalledWith('run-1', 'agent:main:main');
    });
  });

  it('does not build a generic dedupe key for delta events without seq', async () => {
    const { __test_buildGatewayEventDedupeKey } = await import('@/stores/gateway');

    expect(__test_buildGatewayEventDedupeKey({
      state: 'delta',
      runId: 'run-1',
      sessionKey: 'agent:main:main',
    })).toBeNull();

    expect(__test_buildGatewayEventDedupeKey({
      state: 'delta',
      runId: 'run-1',
      sessionKey: 'agent:main:main',
      seq: 1,
    })).toBe('run-1|agent:main:main|1|delta');
  });

  it('maps agent assistant stream text to chat deltas when chat events are missing', async () => {
    hostApiFetchMock.mockResolvedValueOnce({ state: 'running', port: 18789 });

    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useGatewayStore } = await import('@/stores/gateway');
    await useGatewayStore.getState().init();

    handlers.get('gateway:notification')?.({
      method: 'agent',
      params: {
        runId: 'run-1',
        sessionKey: 'agent:main:main',
        stream: 'assistant',
        aseq: 12,
        text: "I'll create this PowerPoint",
      },
    });
    await vi.waitFor(() => {
      expect(chatHandleEventMock).toHaveBeenCalledWith(expect.objectContaining({
        state: 'delta',
        runId: 'run-1',
        message: { role: 'assistant', content: "I'll create this PowerPoint" },
      }));
    });
  });

  it('forwards agent lifecycle errors and refreshes history during active sends', async () => {
    hostApiFetchMock.mockResolvedValueOnce({ state: 'running', port: 18789 });

    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useGatewayStore } = await import('@/stores/gateway');
    await useGatewayStore.getState().init();

    handlers.get('gateway:notification')?.({
      method: 'agent',
      params: {
        runId: 'run-1',
        sessionKey: 'agent:main:main',
        stream: 'lifecycle',
        data: { phase: 'error', error: 'LLM request timed out.' },
      },
    });
    await vi.waitFor(() => {
      expect(chatHandleEventMock).toHaveBeenCalledWith(expect.objectContaining({
        state: 'error',
        runId: 'run-1',
        errorMessage: 'LLM request timed out.',
      }));
      expect(chatLoadHistoryMock).toHaveBeenCalled();
    });
  });

  it('refreshes history on agent item stream during active sends', async () => {
    hostApiFetchMock.mockResolvedValueOnce({ state: 'running', port: 18789 });

    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useGatewayStore } = await import('@/stores/gateway');
    await useGatewayStore.getState().init();

    handlers.get('gateway:notification')?.({
      method: 'agent',
      params: {
        runId: 'run-1',
        sessionKey: 'agent:main:main',
        stream: 'item',
        aseq: 3,
      },
    });
    await vi.waitFor(() => {
      expect(chatLoadHistoryMock).toHaveBeenCalled();
    });
  });

  it('treats agent lifecycle phase=start as run started', async () => {
    hostApiFetchMock.mockResolvedValueOnce({ state: 'running', port: 18789 });

    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useGatewayStore } = await import('@/stores/gateway');
    await useGatewayStore.getState().init();

    handlers.get('gateway:notification')?.({
      method: 'agent',
      params: {
        runId: 'run-1',
        sessionKey: 'agent:main:main',
        stream: 'lifecycle',
        data: { phase: 'start' },
      },
    });
    await vi.waitFor(() => {
      expect(chatHandleEventMock).toHaveBeenCalledWith({
        state: 'started',
        runId: 'run-1',
        sessionKey: 'agent:main:main',
      });
    });
  });

  it('refreshes sessions and current history when local transcript updates arrive', async () => {
    hostApiFetchMock.mockResolvedValueOnce({ state: 'running', port: 18789 });

    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useGatewayStore } = await import('@/stores/gateway');
    await useGatewayStore.getState().init();


    chatStateMock.sending = false;
    chatStateMock.activeRunId = null;
    handlers.get('session:updated')?.({
      agentId: 'main',
      sessionKey: 'agent:main:main',
      fileName: 'main.jsonl',
      reason: 'transcript',
      changedAt: Date.now(),
    });

    await vi.waitFor(() => {
      expect(chatLoadSessionsMock).toHaveBeenCalledWith(true);
      expect(chatLoadHistoryMock).toHaveBeenCalledWith(true, { force: true });
    });
  });
});
