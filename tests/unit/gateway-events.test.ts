import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  hostApiFetchMock,
  subscribeHostEventMock,
  chatLoadHistoryMock,
  chatLoadSessionsMock,
  chatHandleEventMock,
  chatHandleGatewayRunCompletedMock,
  chatSetStateMock,
} = vi.hoisted(() => ({
  hostApiFetchMock: vi.fn(),
  subscribeHostEventMock: vi.fn(),
  chatLoadHistoryMock: vi.fn(),
  chatLoadSessionsMock: vi.fn(),
  chatHandleEventMock: vi.fn(),
  chatHandleGatewayRunCompletedMock: vi.fn(),
  chatSetStateMock: vi.fn(),
}));

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
}));

vi.mock('@/lib/host-events', () => ({
  subscribeHostEvent: (...args: unknown[]) => subscribeHostEventMock(...args),
}));

vi.mock('@/stores/chat', () => ({
  useChatStore: {
    getState: () => ({
      currentSessionKey: 'agent:main:main',
      activeRunId: 'run-1',
      sending: true,
      sessions: [{ key: 'agent:main:main' }],
      loadHistory: chatLoadHistoryMock,
      loadSessions: chatLoadSessionsMock,
      handleChatEvent: chatHandleEventMock,
      handleGatewayRunCompleted: chatHandleGatewayRunCompletedMock,
    }),
    setState: chatSetStateMock,
  },
}));

vi.mock('../../src/stores/chat', () => ({
  useChatStore: {
    getState: () => ({
      currentSessionKey: 'agent:main:main',
      activeRunId: 'run-1',
      sending: true,
      sessions: [{ key: 'agent:main:main' }],
      loadHistory: chatLoadHistoryMock,
      loadSessions: chatLoadSessionsMock,
      handleChatEvent: chatHandleEventMock,
      handleGatewayRunCompleted: chatHandleGatewayRunCompletedMock,
    }),
    setState: chatSetStateMock,
  },
}));

describe('gateway store event wiring', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
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
    expect(useGatewayStore.getState().status.state).toBe('stopped');
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
    // gatewayReady is undefined (old gateway version) — should be treated as ready
    expect(status.gatewayReady).toBeUndefined();
    expect(status.state === 'running' && status.gatewayReady !== false).toBe(true);
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
