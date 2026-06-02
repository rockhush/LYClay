import { beforeEach, describe, expect, it, vi } from 'vitest';
import { extractText } from '@/pages/Chat/message-utils';

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

describe('chat event dedupe', () => {
  beforeEach(() => {
    vi.resetModules();
    window.localStorage.clear();
    gatewayRpcMock.mockReset();
    hostApiFetchMock.mockReset();
    hostApiFetchMock.mockResolvedValue({ success: false, messages: [], error: 'local miss' });
    agentsState.agents = [];
  });

  it('keeps processing delta events without seq for the same run', async () => {
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
      pendingFinal: true,
      lastUserMessageAt: null,
      pendingToolImages: [],
      error: null,
      loading: false,
      thinkingLevel: null,
    });

    useChatStore.getState().handleChatEvent({
      state: 'delta',
      runId: 'run-no-seq',
      sessionKey: 'agent:main:main',
      message: {
        role: 'assistant',
        id: 'reply-stream',
        content: [{ type: 'text', text: 'Checked X.' }],
      },
    });

    useChatStore.getState().handleChatEvent({
      state: 'delta',
      runId: 'run-no-seq',
      sessionKey: 'agent:main:main',
      message: {
        role: 'assistant',
        id: 'reply-stream',
        content: [
          { type: 'text', text: 'Checked X.' },
          { type: 'text', text: 'Checked X. Here is the summary.' },
        ],
      },
    });

    expect(extractText(useChatStore.getState().streamingMessage)).toBe('Checked X. Here is the summary.');
  });

  it('still dedupes repeated delta events when seq matches', async () => {
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

    useChatStore.getState().handleChatEvent({
      state: 'delta',
      runId: 'run-with-seq',
      sessionKey: 'agent:main:main',
      seq: 3,
      message: {
        role: 'assistant',
        id: 'reply-stream',
        content: [{ type: 'text', text: 'first version' }],
      },
    });

    useChatStore.getState().handleChatEvent({
      state: 'delta',
      runId: 'run-with-seq',
      sessionKey: 'agent:main:main',
      seq: 3,
      message: {
        role: 'assistant',
        id: 'reply-stream',
        content: [{ type: 'text', text: 'duplicate version should be ignored' }],
      },
    });

    expect(extractText(useChatStore.getState().streamingMessage)).toBe('first version');
  });

  it('keeps processing final events without seq for tool results and the terminal reply', async () => {
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: true,
      activeRunId: 'run-final-no-seq',
      streamingText: '',
      streamingMessage: {
        role: 'assistant',
        id: 'streaming-tool-call',
        content: [{ type: 'tool_use', id: 'call-1', name: 'read', input: {} }],
      },
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      error: null,
      loading: false,
      thinkingLevel: null,
    });

    useChatStore.getState().handleChatEvent({
      state: 'final',
      runId: 'run-final-no-seq',
      sessionKey: 'agent:main:main',
      message: {
        role: 'toolResult',
        toolCallId: 'call-1',
        content: [{ type: 'text', text: 'tool output' }],
      },
    });

    expect(useChatStore.getState().sending).toBe(true);
    expect(useChatStore.getState().pendingFinal).toBe(true);

    useChatStore.getState().handleChatEvent({
      state: 'final',
      runId: 'run-final-no-seq',
      sessionKey: 'agent:main:main',
      message: {
        role: 'assistant',
        id: 'terminal-reply',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'Final answer after tool output.' }],
      },
    });

    expect(useChatStore.getState().sending).toBe(false);
    expect(useChatStore.getState().activeRunId).toBeNull();
    expect(extractText(useChatStore.getState().messages.at(-1))).toBe('Final answer after tool output.');
  });
});
