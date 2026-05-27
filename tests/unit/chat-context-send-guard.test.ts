import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawMessage } from '@/stores/chat/types';

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

function makeMessages(count: number, contentLength: number): RawMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: '测'.repeat(contentLength),
    id: `msg-${index}`,
  }));
}

describe('prepareContextBeforeSend', () => {
  beforeEach(() => {
    vi.resetModules();
    hostApiFetchMock.mockReset();
    hostApiFetchMock.mockResolvedValue({ contextWindow: 130000 });
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

  it('compresses old history before sending when dynamic trigger is exceeded', async () => {
    const { prepareContextBeforeSend } = await import('@/stores/chat/context-send-guard');
    const invokeCompactorRpc = vi.fn().mockResolvedValue({
      success: true,
      result: { message: { content: '结构化摘要' } },
    });

    const result = await prepareContextBeforeSend({
      sessionKey: 'agent:main:main',
      messages: makeMessages(12, 14000),
      pendingUserMessage: { role: 'user', content: '继续' },
      runtimeMessage: '继续',
      isInternalStagedExecution: false,
      invokeCompactorRpc,
    });

    expect(result.error).toBeUndefined();
    expect(result.compressed).toBe(true);
    expect(invokeCompactorRpc).toHaveBeenCalledWith(
      'chat.send',
      expect.objectContaining({ sessionKey: '__compactor__', deliver: false }),
      60000,
    );
    expect(result.messages[0].role).toBe('system');
    expect(String(result.messages[0].content)).toContain('结构化摘要');
  });

  it('blocks sending when final context exceeds the hard limit', async () => {
    settingsState.contextCompressionEnabled = false;
    const { prepareContextBeforeSend } = await import('@/stores/chat/context-send-guard');
    const invokeCompactorRpc = vi.fn();

    const result = await prepareContextBeforeSend({
      sessionKey: 'agent:main:main',
      messages: makeMessages(12, 50000),
      pendingUserMessage: { role: 'user', content: '继续' },
      runtimeMessage: '继续',
      isInternalStagedExecution: false,
      invokeCompactorRpc,
    });

    expect(result.error).toBe('contextTooLarge');
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
