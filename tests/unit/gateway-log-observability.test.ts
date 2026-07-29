import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', isPackaged: false },
  utilityProcess: { fork: vi.fn() },
}));

vi.mock('@electron/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@electron/utils/uv-env', () => ({
  getUvMirrorEnv: vi.fn(async () => ({})),
  shouldOptimizeNetwork: vi.fn(async () => false),
  warmupNetworkOptimization: vi.fn(async () => undefined),
}));

vi.mock('@electron/utils/openclaw-auth-store', () => ({
  loadAgentAuthProfileStore: vi.fn(async () => ({ version: 1, profiles: {} })),
  saveAgentAuthProfileStore: vi.fn(async () => undefined),
  migrateAllAgentAuthStoresToSqlite: vi.fn(async () => undefined),
  migrateAgentAuthStoreToSqlite: vi.fn(async () => false),
}));

vi.mock('@electron/utils/log-observability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@electron/utils/log-observability')>();
  return {
    ...actual,
    captureLogErrorSnapshot: vi.fn(async () => undefined),
    recordLogEvent: vi.fn(),
  };
});

describe('Gateway ELK admission', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('captures only chat.send RPC failures as user-blocking snapshots', async () => {
    const { GatewayManager } = await import('@electron/gateway/manager');
    const { captureLogErrorSnapshot, recordLogEvent } = await import('@electron/utils/log-observability');
    const manager = new GatewayManager();
    const ws = { readyState: 1, send: vi.fn(), ping: vi.fn(), terminate: vi.fn(), on: vi.fn() };
    (manager as unknown as { ws: typeof ws }).ws = ws;

    const abortPromise = manager.rpc('sessions.abort', { key: 'agent:deleted:session-1' }, 1000);
    await vi.waitFor(() => expect(
      (manager as unknown as { pendingRequests: Map<string, unknown> }).pendingRequests.size,
    ).toBe(1));
    const abortRequestId = Array.from(
      (manager as unknown as { pendingRequests: Map<string, unknown> }).pendingRequests.keys(),
    )[0];
    (manager as unknown as { handleMessage: (message: unknown) => void }).handleMessage({
      type: 'res',
      id: abortRequestId,
      ok: false,
      error: { message: 'Unknown agent id "deleted"' },
    });
    await expect(abortPromise).rejects.toThrow('Unknown agent id');
    expect(captureLogErrorSnapshot).not.toHaveBeenCalled();

    const chatPromise = manager.rpc('chat.send', {
      sessionKey: 'agent:main:session-1',
      message: 'hello',
      idempotencyKey: 'send-1',
    }, 1000);
    await vi.waitFor(() => expect(
      (manager as unknown as { pendingRequests: Map<string, unknown> }).pendingRequests.size,
    ).toBe(1));
    const chatRequestId = Array.from(
      (manager as unknown as { pendingRequests: Map<string, unknown> }).pendingRequests.keys(),
    )[0];
    (manager as unknown as { handleMessage: (message: unknown) => void }).handleMessage({
      type: 'res',
      id: chatRequestId,
      ok: false,
      error: { message: 'model unavailable' },
    });
    await expect(chatPromise).rejects.toThrow('model unavailable');
    expect(captureLogErrorSnapshot).toHaveBeenCalledTimes(1);
    expect(captureLogErrorSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      userImpact: 'blocking',
      operationKind: 'user_chat',
      failureStage: 'gateway_rpc',
      method: 'chat.send',
      sessionKey: 'agent:main:session-1',
    }));
    expect(recordLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventName: 'gateway.rpc',
      method: 'chat.send',
      sessionId: 'agent:main:session-1',
      status: 'failed',
    }));
  });

  it('keeps an ambiguous chat.send ack timeout in recent events without uploading it', async () => {
    const { GatewayManager } = await import('@electron/gateway/manager');
    const { captureLogErrorSnapshot, recordLogEvent } = await import('@electron/utils/log-observability');
    const manager = new GatewayManager();
    const ws = { readyState: 1, send: vi.fn(), ping: vi.fn(), terminate: vi.fn(), on: vi.fn() };
    (manager as unknown as { ws: typeof ws }).ws = ws;

    const pending = manager.rpc('chat.send', {
      sessionKey: 'agent:main:session-timeout',
      message: 'hello',
      idempotencyKey: 'send-timeout',
    }, 10);

    await expect(pending).rejects.toThrow('RPC timeout: chat.send');
    expect(recordLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      method: 'chat.send',
      status: 'timeout',
    }));
    expect(captureLogErrorSnapshot).not.toHaveBeenCalled();
  });

  it.each([
    ['warmup', { sessionKey: 'agent:main:__warmup__', message: 'warmup' }],
    ['cron', { sessionKey: 'agent:main:cron:daily', message: 'scheduled task' }],
    ['internal feedback', { sessionKey: 'agent:main:session-1', message: '[LYCLAW internal tool failure feedback] retry' }],
  ])('does not upload failed %s chat.send requests', async (_label, params) => {
    const { GatewayManager } = await import('@electron/gateway/manager');
    const { captureLogErrorSnapshot } = await import('@electron/utils/log-observability');
    const manager = new GatewayManager();
    const ws = { readyState: 1, send: vi.fn(), ping: vi.fn(), terminate: vi.fn(), on: vi.fn() };
    (manager as unknown as { ws: typeof ws }).ws = ws;

    const pending = manager.rpc('chat.send', params, 1000);
    await vi.waitFor(() => expect(
      (manager as unknown as { pendingRequests: Map<string, unknown> }).pendingRequests.size,
    ).toBe(1));
    const requestId = Array.from(
      (manager as unknown as { pendingRequests: Map<string, unknown> }).pendingRequests.keys(),
    )[0];
    (manager as unknown as { handleMessage: (message: unknown) => void }).handleMessage({
      type: 'res',
      id: requestId,
      ok: false,
      error: { message: 'background request failed' },
    });

    await expect(pending).rejects.toThrow('background request failed');
    expect(captureLogErrorSnapshot).not.toHaveBeenCalled();
  });

  it('identifies only tracked user chat runs for lifecycle snapshots', async () => {
    const { GatewayManager } = await import('@electron/gateway/manager');
    const manager = new GatewayManager();
    const metrics = (manager as unknown as { chatRunMetrics: Map<string, unknown> }).chatRunMetrics;
    metrics.set('run-user', { kind: 'user', sessionKey: 'agent:main:session-1' });
    metrics.set('run-internal', { kind: 'internal', sessionKey: 'agent:main:session-2' });

    expect(manager.isTrackedUserChatRun('run-user', 'agent:main:session-1')).toBe(true);
    expect(manager.isTrackedUserChatRun('run-internal', 'agent:main:session-2')).toBe(false);
    expect(manager.isTrackedUserChatRun('missing-run', 'agent:main:session-1')).toBe(false);
    expect(manager.isTrackedUserChatRun(undefined, 'agent:main:session-1')).toBe(false);
  });
});
