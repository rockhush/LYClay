import { beforeEach, describe, expect, it, vi } from 'vitest';

const hostApiFetchMock = vi.hoisted(() => vi.fn());
const agentsState = vi.hoisted(() => ({
  agents: [{ id: 'main', modelRef: 'ly-deepseek/deepseek-v4-flash' }],
  defaultModelRef: 'ly-deepseek/deepseek-v4-flash',
}));
const settingsState = vi.hoisted(() => ({
  contextCompressionEnabled: true,
}));

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: hostApiFetchMock,
}));

vi.mock('@/stores/agents', () => ({
  useAgentsStore: {
    getState: () => agentsState,
  },
}));

vi.mock('@/stores/settings', () => ({
  useSettingsStore: {
    getState: () => settingsState,
  },
}));

describe('prepareContextBeforeSend', () => {
  beforeEach(() => {
    vi.resetModules();
    hostApiFetchMock.mockReset();
    // Default: model-context returns 130K, token-usage returns 0 (no data yet)
    hostApiFetchMock.mockImplementation((url: string) => {
      if (String(url).includes('token-usage')) return Promise.resolve({ totalTokens: 0 });
      return Promise.resolve({ contextWindow: 130000 });
    });
    settingsState.contextCompressionEnabled = true;
  });

  it('blocks a single current user message that is too large', async () => {
    const { prepareContextBeforeSend } = await import('@/stores/chat/context-send-guard');
    const invokeCompactorRpc = vi.fn();

    const result = await prepareContextBeforeSend({
      sessionKey: 'agent:main:main',
      messages: [],
      pendingUserMessage: { role: 'user', content: 'x'.repeat(400000) },
      runtimeMessage: 'x'.repeat(400000),
      isInternalStagedExecution: false,
      invokeCompactorRpc,
    });

    expect(result.error).toBe('currentMessageTooLarge');
    expect(invokeCompactorRpc).not.toHaveBeenCalled();
  });

  it('triggers sessions.compact when gateway reports tokens above threshold', async () => {
    hostApiFetchMock.mockImplementation((url: string) => {
      if (String(url).includes('token-usage')) return Promise.resolve({ totalTokens: 80000 });
      return Promise.resolve({ contextWindow: 130000 });
    });

    const { prepareContextBeforeSend } = await import('@/stores/chat/context-send-guard');
    const invokeCompactorRpc = vi.fn().mockResolvedValue({ compacted: true, ok: true });
    const statusUpdates = vi.fn();

    const result = await prepareContextBeforeSend({
      sessionKey: 'agent:main:main',
      messages: [{ role: 'user', content: 'hello' }],
      pendingUserMessage: { role: 'user', content: 'hi' },
      runtimeMessage: 'hi',
      isInternalStagedExecution: false,
      invokeCompactorRpc,
      onCompressionStatus: statusUpdates,
    });

    expect(result.error).toBeUndefined();
    expect(result.compressed).toBe(true);
    expect(result.gatewayCompacted).toBe(true);
    expect(invokeCompactorRpc).toHaveBeenCalledWith('sessions.compact', { key: 'agent:main:main' }, 120_000);
  });

  it('skips compaction when gateway tokens are below threshold', async () => {
    hostApiFetchMock.mockImplementation((url: string) => {
      if (String(url).includes('token-usage')) return Promise.resolve({ totalTokens: 30000 });
      return Promise.resolve({ contextWindow: 130000 });
    });

    const { prepareContextBeforeSend } = await import('@/stores/chat/context-send-guard');
    const invokeCompactorRpc = vi.fn();

    const result = await prepareContextBeforeSend({
      sessionKey: 'agent:main:main',
      messages: [{ role: 'user', content: 'hello' }],
      pendingUserMessage: { role: 'user', content: 'hi' },
      runtimeMessage: 'hi',
      isInternalStagedExecution: false,
      invokeCompactorRpc,
    });

    expect(result.error).toBeUndefined();
    expect(result.compressed).toBe(false);
    // sessions.compact NOT called because 30K < 69,888 threshold
    expect(invokeCompactorRpc).not.toHaveBeenCalled();
  });

  it('skips compaction when gateway has no token data (returns 0)', async () => {
    const { prepareContextBeforeSend } = await import('@/stores/chat/context-send-guard');
    const invokeCompactorRpc = vi.fn();

    const result = await prepareContextBeforeSend({
      sessionKey: 'agent:main:main',
      messages: [{ role: 'user', content: 'hello' }],
      pendingUserMessage: { role: 'user', content: 'hi' },
      runtimeMessage: 'hi',
      isInternalStagedExecution: false,
      invokeCompactorRpc,
    });

    expect(result.error).toBeUndefined();
    expect(result.compressed).toBe(false);
    expect(invokeCompactorRpc).not.toHaveBeenCalled();
  });

  it('uses the default budget when contextWindow cannot be resolved', async () => {
    hostApiFetchMock.mockRejectedValue(new Error('network'));
    const { DEFAULT_CONTEXT_WINDOW } = await import('@/stores/chat/context-budget');
    const { prepareContextBeforeSend } = await import('@/stores/chat/context-send-guard');

    const result = await prepareContextBeforeSend({
      sessionKey: 'agent:main:main',
      messages: [],
      pendingUserMessage: { role: 'user', content: 'hello' },
      runtimeMessage: 'hello',
      isInternalStagedExecution: false,
      invokeCompactorRpc: vi.fn(),
    });

    expect(result.error).toBeUndefined();
    expect(result.budget.contextWindow).toBe(DEFAULT_CONTEXT_WINDOW);
  });
});
