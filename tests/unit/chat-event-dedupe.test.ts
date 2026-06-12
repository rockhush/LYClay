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

  it('progressively applies cumulative text deltas with increasing seq values', async () => {
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [{ role: 'user', content: 'Write an essay about my alma mater' }],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: true,
      activeRunId: 'run-essay-stream',
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: Date.now(),
      pendingToolImages: [],
      error: null,
      loading: false,
      thinkingLevel: null,
    });

    useChatStore.getState().handleChatEvent({
      state: 'delta',
      runId: 'run-essay-stream',
      sessionKey: 'agent:main:main',
      seq: 1,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'My alma mater' }],
      },
    });
    expect(extractText(useChatStore.getState().streamingMessage)).toBe('My alma mater');

    useChatStore.getState().handleChatEvent({
      state: 'delta',
      runId: 'run-essay-stream',
      sessionKey: 'agent:main:main',
      seq: 2,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'My alma mater holds many memories.' }],
      },
    });
    expect(extractText(useChatStore.getState().streamingMessage)).toBe('My alma mater holds many memories.');
  });

  it('clears current session execution state when final event has no message', async () => {
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [],
      sessionLabels: {},
      sessionLastActivity: {},
      sessionStreamingStates: {},
      sending: true,
      activeRunId: 'run-empty-final',
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: true,
      lastUserMessageAt: 123,
      pendingToolImages: [],
      error: null,
      loading: false,
      thinkingLevel: null,
    });

    useChatStore.getState().handleChatEvent({
      state: 'final',
      runId: 'run-empty-final',
      sessionKey: 'agent:main:main',
    });

    expect(useChatStore.getState().sending).toBe(false);
    expect(useChatStore.getState().activeRunId).toBeNull();
    expect(useChatStore.getState().pendingFinal).toBe(false);
    expect(useChatStore.getState().lastUserMessageAt).toBeNull();
  });

  it('clears background session execution state when its final event arrives', async () => {
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:session-b',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:session-a' }, { key: 'agent:main:session-b' }],
      messages: [],
      sessionLabels: {},
      sessionLastActivity: {},
      sessionStreamingStates: {
        'agent:main:session-a': {
          activeRunId: 'run-a',
          streamingText: '',
          streamingMessage: { role: 'assistant', content: [{ type: 'text', text: 'working' }] },
          streamingTools: [],
          pendingFinal: false,
          lastUserMessageAt: 123,
          pendingToolImages: [],
          runAborted: false,
          sending: true,
          messagesSnapshot: [{ role: 'user', content: 'A task' }],
        },
      },
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
      state: 'final',
      runId: 'run-a',
      sessionKey: 'agent:main:session-a',
      message: {
        role: 'assistant',
        id: 'final-a',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'A is done.' }],
      },
    });

    const background = useChatStore.getState().sessionStreamingStates['agent:main:session-a'];
    expect(background.sending).toBe(false);
    expect(background.activeRunId).toBeNull();
    expect(background.pendingFinal).toBe(false);
    expect(background.streamingMessage).toBeNull();
    expect(extractText(background.messagesSnapshot.at(-1))).toBe('A is done.');
    expect(useChatStore.getState().currentSessionKey).toBe('agent:main:session-b');
    expect(useChatStore.getState().sending).toBe(false);
  });
});
