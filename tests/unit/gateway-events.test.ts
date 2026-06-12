import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  hostApiFetchMock,
  subscribeHostEventMock,
  chatLoadHistoryMock,
  chatLoadSessionsMock,
  chatHandleEventMock,
  chatSetStateMock,
} = vi.hoisted(() => ({
  hostApiFetchMock: vi.fn(),
  subscribeHostEventMock: vi.fn(),
  chatLoadHistoryMock: vi.fn(),
  chatLoadSessionsMock: vi.fn(),
  chatHandleEventMock: vi.fn(),
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

  it('does not finalize active chat state on agent phase end notifications', async () => {
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
        data: { phase: 'end' },
      },
    });

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(chatSetStateMock).not.toHaveBeenCalled();
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
});
