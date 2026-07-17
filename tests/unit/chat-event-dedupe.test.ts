import { beforeEach, describe, expect, it, vi } from 'vitest';
import { extractText } from '@/pages/Chat/message-utils';

const { gatewayRpcMock, hostApiFetchMock, getSessionBackendActivityMock, agentsState } = vi.hoisted(() => ({
  gatewayRpcMock: vi.fn(),
  hostApiFetchMock: vi.fn(),
  getSessionBackendActivityMock: vi.fn(),
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
    subscribe: vi.fn(() => vi.fn()),
  },
}));

vi.mock('@/stores/agents', () => ({
  useAgentsStore: {
    getState: () => agentsState,
  },
}));

vi.mock('@/stores/digital-employees', () => ({
  useDigitalEmployeesStore: {
    getState: () => ({ employees: [] }),
  },
}));

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
  getEmptyFinalDiagnostic: (...args: unknown[]) => hostApiFetchMock(...args),
  getSessionBackendActivity: (...args: unknown[]) => getSessionBackendActivityMock(...args),
  recoverStaleSessionAfterEmptyFinal: (...args: unknown[]) => hostApiFetchMock(...args),
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
    getSessionBackendActivityMock.mockReset();
    hostApiFetchMock.mockResolvedValue({ success: false, messages: [], error: 'local miss' });
    getSessionBackendActivityMock.mockResolvedValue({
      success: true,
      session: {
        sessionKey: 'agent:main:main',
        status: 'completed',
        processing: false,
        hasTrackedUserRun: false,
        activeRunIds: [],
      },
      background: {
        hasBackgroundProcessing: false,
        processingSessionKeys: [],
      },
    });
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
  }, 10_000);

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

  it('surfaces recovery state when an empty final is confirmed stale by diagnostics', async () => {
    vi.useFakeTimers();
    const { handleRuntimeEventState } = await import('@/stores/chat/runtime-event-handlers');
    hostApiFetchMock.mockResolvedValueOnce({
      success: true,
      diagnostic: {
        recoveryResult: { recovered: false, reason: 'lock-owned-by-other-process' },
        transcriptLockOwner: { pid: 999999, pidAlive: false },
      },
      hasTrackedActiveRun: false,
    });
    const state: Record<string, unknown> = {
      currentSessionKey: 'agent:main:main',
      messages: [{ role: 'user', content: 'Question', timestamp: 123 }],
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
      runError: null,
      emptyFinalRecovery: { status: 'idle' },
      loading: false,
      loadHistory: vi.fn(async () => undefined),
    };
    const set = (patch: Record<string, unknown> | ((s: Record<string, unknown>) => Record<string, unknown>)) => {
      Object.assign(state, typeof patch === 'function' ? patch(state) : patch);
    };
    const get = () => state;

    handleRuntimeEventState(set as never, get as never, { state: 'final' }, 'final', 'run-empty-final');

    await vi.advanceTimersByTimeAsync(0);
    expect(state.loadHistory).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(state.loadHistory).toHaveBeenCalledTimes(2);
    expect(state.sending).toBe(false);
    expect(state.activeRunId).toBeNull();
    expect(state.pendingFinal).toBe(false);
    expect(state.lastUserMessageAt).toBeNull();
    expect(state.runError).toContain('Run ended without a response');
    expect(state.emptyFinalRecovery).toMatchObject({
      status: 'stale',
      reason: 'lock-owned-by-other-process',
    });
    vi.useRealTimers();
  });

  it('keeps waiting when empty-final diagnostics show the session may still be active', async () => {
    vi.useFakeTimers();
    const { handleRuntimeEventState } = await import('@/stores/chat/runtime-event-handlers');
    hostApiFetchMock.mockResolvedValueOnce({
      success: true,
      diagnostic: {
        recoveryResult: { recovered: false, reason: 'tracked-active-run' },
      },
      hasTrackedActiveRun: true,
    });
    const state: Record<string, unknown> = {
      currentSessionKey: 'agent:main:main',
      messages: [{ role: 'user', content: 'Question', timestamp: 123 }],
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
      runError: null,
      emptyFinalRecovery: { status: 'idle' },
      loading: false,
      loadHistory: vi.fn(async () => undefined),
    };
    const set = (patch: Record<string, unknown> | ((s: Record<string, unknown>) => Record<string, unknown>)) => {
      Object.assign(state, typeof patch === 'function' ? patch(state) : patch);
    };
    const get = () => state;

    handleRuntimeEventState(set as never, get as never, { state: 'final' }, 'final', 'run-empty-final');

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(state.runError).toBeNull();
    expect(state.pendingFinal).toBe(true);
    expect(state.emptyFinalRecovery).toMatchObject({
      status: 'waiting',
      reason: 'tracked-active-run',
    });
    vi.useRealTimers();
  });

  it('completes an empty final when history reload surfaces assistant output', async () => {
    const { useChatStore } = await import('@/stores/chat');
    hostApiFetchMock.mockResolvedValueOnce({
      success: true,
      messages: [
        { role: 'user', content: 'Question', timestamp: 123 },
        { role: 'assistant', content: 'Answer from transcript', timestamp: 124 },
      ],
    });

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [{ role: 'user', content: 'Question', timestamp: 123 }],
      sessionLabels: {},
      sessionLastActivity: {},
      sessionStreamingStates: {},
      sending: true,
      activeRunId: 'run-empty-final-history',
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: true,
      lastUserMessageAt: 123,
      pendingToolImages: [],
      error: null,
      runError: null,
      loading: false,
      thinkingLevel: null,
    });

    useChatStore.getState().handleChatEvent({
      state: 'final',
      runId: 'run-empty-final-history',
      sessionKey: 'agent:main:main',
    });

    await vi.waitFor(() => {
      expect(useChatStore.getState().sending).toBe(false);
    });

    const state = useChatStore.getState();
    expect(state.activeRunId).toBeNull();
    expect(state.pendingFinal).toBe(false);
    expect(state.lastUserMessageAt).toBeNull();
    expect(state.runError).toBeNull();
    expect(extractText(state.messages.at(-1))).toBe('Answer from transcript');
    expect(hostApiFetchMock).toHaveBeenCalledTimes(1);
  });

  it('clears current session execution state when an exec approval followup final arrives', async () => {
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
      activeRunId: 'run-original',
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
      runId: 'exec-approval-followup:approval-1',
      sessionKey: 'agent:main:main',
    });

    expect(useChatStore.getState().sending).toBe(false);
    expect(useChatStore.getState().activeRunId).toBeNull();
    expect(useChatStore.getState().pendingFinal).toBe(false);
    expect(useChatStore.getState().lastUserMessageAt).toBeNull();
  });

  it('clears exec approval followup text finals even after prior tool use when stop reason is absent', async () => {
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [
        { role: 'user', content: 'Generate a deck' },
        {
          role: 'assistant',
          id: 'tool-use-1',
          content: [
            { type: 'text', text: 'Checking exports.' },
            { type: 'tool_use', id: 'call-1', name: 'exec', input: { command: 'dir exports' } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'hunan-intro.pptx' }],
        },
      ],
      sessionLabels: {},
      sessionLastActivity: {},
      sessionStreamingStates: {},
      sending: true,
      activeRunId: 'exec-approval-followup:approval-1',
      streamingText: '',
      streamingMessage: { role: 'assistant', content: [{ type: 'text', text: 'thinking' }] },
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
      runId: 'exec-approval-followup:approval-1',
      sessionKey: 'agent:main:main',
      message: {
        role: 'assistant',
        id: 'final-report',
        content: [{ type: 'text', text: 'PPT generated successfully.' }],
      },
    });

    await vi.waitFor(() => {
      expect(useChatStore.getState().sending).toBe(false);
    });

    const state = useChatStore.getState();
    expect(state.sending).toBe(false);
    expect(state.activeRunId).toBeNull();
    expect(state.pendingFinal).toBe(false);
    expect(state.streamingMessage).toBeNull();
    expect(extractText(state.messages.at(-1))).toBe('PPT generated successfully.');
  });

  it('clears a same-run empty final only after backend is idle', async () => {
    vi.useFakeTimers();
    const { useChatStore } = await import('@/stores/chat');

    hostApiFetchMock.mockImplementation((path: string) => {
      if (path === 'agent:main:main' || path.startsWith('/api/sessions/empty-final-diagnostic')) {
        return Promise.resolve({
          success: true,
          diagnostic: {
            recoveryResult: { recovered: false, reason: 'lock-missing' },
          },
          hasTrackedActiveRun: false,
        });
      }
      return Promise.resolve({ success: false, messages: [], error: 'local miss' });
    });
    gatewayRpcMock.mockResolvedValue({ messages: [] });

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [{ role: 'user', content: 'hello', timestamp: 123 }],
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

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(0);

    await vi.waitFor(() => expect(useChatStore.getState().sending).toBe(false));
    expect(useChatStore.getState().activeRunId).toBeNull();
    expect(useChatStore.getState().pendingFinal).toBe(false);
    expect(hostApiFetchMock).toHaveBeenCalledWith('agent:main:main');
    vi.useRealTimers();
  });

  it('keeps a same-run empty final active while backend still tracks work', async () => {
    vi.useFakeTimers();
    const { useChatStore } = await import('@/stores/chat');

    hostApiFetchMock.mockImplementation((path: string) => {
      if (path === 'agent:main:main' || path.startsWith('/api/sessions/empty-final-diagnostic')) {
        return Promise.resolve({
          success: true,
          diagnostic: {
            recoveryResult: { recovered: false, reason: 'session-active' },
          },
          hasTrackedActiveRun: true,
        });
      }
      return Promise.resolve({ success: false, messages: [], error: 'local miss' });
    });
    gatewayRpcMock.mockResolvedValue({ messages: [] });

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [{ role: 'user', content: 'hello', timestamp: 123 }],
      sessionLabels: {},
      sessionLastActivity: {},
      sessionStreamingStates: {},
      sending: true,
      activeRunId: 'run-empty-final-active',
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
      runId: 'run-empty-final-active',
      sessionKey: 'agent:main:main',
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(0);

    await vi.waitFor(() => expect(hostApiFetchMock).toHaveBeenCalledWith('agent:main:main'));
    expect(useChatStore.getState().sending).toBe(true);
    expect(useChatStore.getState().activeRunId).toBe('run-empty-final-active');
    expect(useChatStore.getState().pendingFinal).toBe(true);
    vi.useRealTimers();
  });

  it('keeps empty finals open while a delegated child turn is still unresolved', async () => {
    vi.useFakeTimers();
    const { useChatStore } = await import('@/stores/chat');
    const sessionKey = 'agent:main:delegated-empty-final';
    const childSessionKey = 'agent:main:subagent:child-empty-final';
    const userTimestamp = Date.now();

    hostApiFetchMock.mockResolvedValue({ success: false, messages: [], error: 'local miss' });
    gatewayRpcMock.mockResolvedValue({ messages: [] });

    useChatStore.setState({
      currentSessionKey: sessionKey,
      currentAgentId: 'main',
      sessions: [{ key: sessionKey }],
      messages: [
        { role: 'user', content: 'Generate a PPT via sub-agent', id: 'user-delegated-empty', timestamp: userTimestamp },
        {
          role: 'assistant',
          id: 'spawn-delegated-empty',
          content: [{ type: 'tool_use', id: 'spawn-1', name: 'sessions_spawn', input: { task: 'Generate PPT' } }],
          stopReason: 'toolUse',
          timestamp: userTimestamp + 1,
        },
        {
          role: 'toolResult',
          id: 'spawn-result-delegated-empty',
          toolCallId: 'spawn-1',
          content: [{
            type: 'text',
            text: JSON.stringify({ status: 'accepted', childSessionKey, runId: 'child-run-1' }),
          }],
          timestamp: userTimestamp + 2,
        },
      ],
      sessionLabels: {},
      sessionLastActivity: {},
      sessionStreamingStates: {},
      sending: true,
      activeRunId: 'parent-run-empty-final',
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: true,
      lastUserMessageAt: userTimestamp,
      pendingToolImages: [],
      error: null,
      runError: null,
      emptyFinalRecovery: { status: 'idle' },
      loading: false,
      thinkingLevel: null,
      gatewayBackgroundActivity: { hasBackgroundProcessing: false, processingSessionKeys: [childSessionKey] },
      sessionBackendActivity: {
        sessionKey,
        status: 'idle',
        processing: false,
        hasTrackedUserRun: false,
        activeRunIds: [],
      },
    });

    useChatStore.getState().handleChatEvent({
      state: 'final',
      runId: 'parent-run-empty-final',
      sessionKey,
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(0);

    const state = useChatStore.getState();
    expect(state.emptyFinalRecovery.status).toBe('idle');
    expect(state.runError).toBeNull();
    expect(state.sending).toBe(true);
    expect(state.activeRunId).toBe('parent-run-empty-final');
    expect(state.pendingFinal).toBe(true);
    expect(hostApiFetchMock).not.toHaveBeenCalledWith('/api/sessions/empty-final-diagnostic?sessionKey=agent%3Amain%3Adelegated-empty-final');
    vi.useRealTimers();
  });
  it('reconciles mismatched final events without appending their message directly', async () => {
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
      activeRunId: 'run-original',
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
      runId: 'run-other',
      sessionKey: 'agent:main:main',
      message: {
        role: 'assistant',
        id: 'stale-final',
        content: [{ type: 'text', text: 'Stale final should come from history only.' }],
      },
    });

    expect(useChatStore.getState().sending).toBe(true);
    expect(useChatStore.getState().activeRunId).toBe('run-original');
    expect(useChatStore.getState().pendingFinal).toBe(true);
    expect(useChatStore.getState().lastUserMessageAt).toBe(123);
    expect(useChatStore.getState().messages).toEqual([]);
    await vi.waitFor(() => expect(hostApiFetchMock).toHaveBeenCalled());
  });

  it('closes a text final even when prior messages used tools', async () => {
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [
        { role: 'user', content: 'Generate a deck' },
        {
          role: 'assistant',
          id: 'tool-use-1',
          content: [
            { type: 'text', text: 'I will inspect the project.' },
            { type: 'tool_use', id: 'call-1', name: 'exec', input: { command: 'dir' } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'ok' }],
        },
      ],
      sessionLabels: {},
      sessionLastActivity: {},
      sessionStreamingStates: {},
      sending: true,
      activeRunId: 'run-stage-final',
      streamingText: '',
      streamingMessage: { role: 'assistant', content: [{ type: 'text', text: 'Installing requests...' }] },
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
      runId: 'run-stage-final',
      sessionKey: 'agent:main:main',
      message: {
        role: 'assistant',
        id: 'stage-final-text',
        content: [{ type: 'text', text: 'I need requests in this Python environment. Installing it now:' }],
      },
    });

    await vi.waitFor(() => {
      expect(useChatStore.getState().sending).toBe(false);
    });

    const state = useChatStore.getState();
    expect(state.sending).toBe(false);
    expect(state.activeRunId).toBeNull();
    expect(state.pendingFinal).toBe(false);
    expect(extractText(state.messages.at(-1))).toContain('Installing it now');
  });

  it('commits a cumulative DingTalk final and settles despite lagging backend activity', async () => {
    vi.useFakeTimers();
    try {
      const { useChatStore } = await import('@/stores/chat');
      const userTimestamp = Date.now();
      const sessionKey = 'agent:main:session-dingtalk-cumulative-final';
      const runId = 'run-dingtalk-cumulative-final';
      const firstNarration = '我需要先查找邓永坚的钉钉用户ID。';
      const lastNarration = '还需要指定 --file-path 参数。';
      const finalReply = '已成功将老虎图片发送给邓永坚（Yongjian Deng/邓永坚）。';

      getSessionBackendActivityMock.mockResolvedValue({
        success: true,
        session: {
          sessionKey,
          status: 'running',
          processing: true,
          hasTrackedUserRun: true,
          activeRunIds: [runId],
        },
        background: {
          hasBackgroundProcessing: true,
          processingSessionKeys: [sessionKey],
        },
      });

      useChatStore.setState({
        currentSessionKey: sessionKey,
        currentAgentId: 'main',
        sessions: [{ key: sessionKey }],
        messages: [
          {
            role: 'user',
            id: 'user-dingtalk-image',
            timestamp: userTimestamp,
            content: '把老虎图片发给邓永坚',
          },
          {
            role: 'assistant',
            id: 'tool-round-1',
            timestamp: userTimestamp + 1,
            stopReason: 'toolUse',
            content: [
              { type: 'text', text: firstNarration },
              {
                type: 'tool_use',
                id: 'call-find-user',
                name: 'exec',
                input: { command: 'find-dingtalk-user' },
              },
            ],
          },
          {
            role: 'toolResult',
            id: 'tool-result-1',
            timestamp: userTimestamp + 2,
            toolCallId: 'call-find-user',
            content: [{ type: 'text', text: 'user found' }],
          },
          {
            role: 'assistant',
            id: 'tool-round-2',
            timestamp: userTimestamp + 3,
            stopReason: 'toolUse',
            content: [
              { type: 'text', text: lastNarration },
              {
                type: 'tool_use',
                id: 'call-send-image',
                name: 'exec',
                input: { command: 'send-dingtalk-image' },
              },
            ],
          },
          {
            role: 'toolResult',
            id: 'tool-result-2',
            timestamp: userTimestamp + 4,
            toolCallId: 'call-send-image',
            content: [{ type: 'text', text: 'message sent' }],
          },
        ],
        sessionLabels: {},
        sessionLastActivity: {},
        sessionStreamingStates: {},
        sending: true,
        activeRunId: runId,
        streamingText: `${firstNarration}${lastNarration}${finalReply}`,
        streamingMessage: {
          role: 'assistant',
          content: [{ type: 'text', text: `${firstNarration}${lastNarration}${finalReply}` }],
        },
        streamingTools: [],
        pendingFinal: true,
        lastUserMessageAt: userTimestamp,
        pendingToolImages: [],
        error: null,
        runError: null,
        loading: false,
        thinkingLevel: null,
        sessionBackendActivity: {
          sessionKey,
          status: 'running',
          processing: true,
          hasTrackedUserRun: true,
          activeRunIds: [runId],
        },
        gatewayBackgroundActivity: {
          hasBackgroundProcessing: true,
          processingSessionKeys: [sessionKey],
        },
      });

      useChatStore.getState().handleChatEvent({
        state: 'final',
        runId,
        sessionKey,
        message: {
          role: 'assistant',
          timestamp: userTimestamp + 5,
          content: [{
            type: 'text',
            text: `${firstNarration}${lastNarration}${finalReply}`,
          }],
        },
      });

      await vi.advanceTimersByTimeAsync(0);

      const state = useChatStore.getState();
      expect(state.messages.some((message) => extractText(message).includes(finalReply))).toBe(true);
      expect(state).toMatchObject({
        sending: false,
        activeRunId: null,
        pendingFinal: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries authoritative history when the first printer-final reload is stale', async () => {
    const { useChatStore } = await import('@/stores/chat');
    const userTimestamp = Date.now();
    const sessionKey = 'agent:main:session-printer-cumulative-final';
    const runId = 'run-printer-cumulative-final';
    const printerFailureNarration = '打印失败。错误显示 `cscript.exe` 超时，这可能是 Office COM 打印的问题。让我检查一下默认打印机状态和 SumatraPDF 是否安装：';
    const printerDiagnosisNarration = '问题找到了：当前默认打印机是 Microsoft Print to PDF，这是虚拟打印机。让我继续检查可用的实体打印机和文件格式：';
    const finalReply = '打印失败了。错误信息显示 `cscript.exe` 命令超时。这可能是由于 Word 文件打印需要 Word COM 组件支持，而 CScript 超时表明 Word 没有正确响应。';
    const authoritativeMessages = [
      { role: 'user', id: 'printer-user', timestamp: userTimestamp, content: '打印 test3 文件夹中的文件' },
      {
        role: 'assistant',
        id: 'printer-tool-round-1',
        timestamp: userTimestamp + 1,
        stopReason: 'toolUse',
        content: [
          { type: 'text', text: printerFailureNarration },
          { type: 'tool_use', id: 'check-printer', name: 'exec', input: { command: 'check-printer' } },
        ],
      },
      {
        role: 'toolResult',
        id: 'printer-tool-result-1',
        timestamp: userTimestamp + 2,
        toolCallId: 'check-printer',
        content: [{ type: 'text', text: 'Microsoft Print to PDF' }],
      },
      {
        role: 'assistant',
        id: 'printer-tool-round-2',
        timestamp: userTimestamp + 3,
        stopReason: 'toolUse',
        content: [
          { type: 'text', text: printerDiagnosisNarration },
          { type: 'tool_use', id: 'check-sumatra', name: 'exec', input: { command: 'check-sumatra' } },
        ],
      },
      {
        role: 'toolResult',
        id: 'printer-tool-result-2',
        timestamp: userTimestamp + 4,
        toolCallId: 'check-sumatra',
        content: [{ type: 'text', text: 'not installed' }],
      },
      {
        role: 'assistant',
        id: 'printer-authoritative-final',
        timestamp: userTimestamp + 5,
        stopReason: 'stop',
        content: [{ type: 'text', text: finalReply }],
      },
    ];

    hostApiFetchMock
      .mockResolvedValueOnce({
        success: true,
        messages: authoritativeMessages.slice(0, -1),
      })
      .mockResolvedValueOnce({
        success: true,
        messages: authoritativeMessages,
      });

    useChatStore.setState({
      currentSessionKey: sessionKey,
      currentAgentId: 'main',
      sessions: [{ key: sessionKey }],
      messages: authoritativeMessages.slice(0, -1),
      sessionLabels: {},
      sessionLastActivity: {},
      sessionStreamingStates: {},
      sending: true,
      activeRunId: runId,
      streamingText: `${printerFailureNarration}${printerDiagnosisNarration}${finalReply}`,
      streamingMessage: {
        role: 'assistant',
        content: [{
          type: 'text',
          text: `${printerFailureNarration}${printerDiagnosisNarration}${finalReply}`,
        }],
      },
      streamingTools: [],
      pendingFinal: true,
      lastUserMessageAt: userTimestamp,
      pendingToolImages: [],
      error: null,
      runError: null,
      loading: false,
      thinkingLevel: null,
    });

    useChatStore.getState().handleChatEvent({
      state: 'final',
      runId,
      sessionKey,
      message: {
        role: 'assistant',
        timestamp: userTimestamp + 5,
        content: [{
          type: 'text',
          text: `${printerFailureNarration}${printerDiagnosisNarration}${finalReply}`,
        }],
      },
    });

    await vi.waitFor(() => {
      expect(useChatStore.getState().messages.some(
        (message) => message.id === 'printer-authoritative-final' && extractText(message) === finalReply,
      )).toBe(true);
    });

    const state = useChatStore.getState();
    expect(state.messages.some(
      (message) => message.id === 'printer-tool-round-1' && message.stopReason === 'toolUse',
    )).toBe(true);
    expect(state.messages.at(-1)?.id).toBe('printer-authoritative-final');
    expect(state.sending).toBe(false);
    expect(state.activeRunId).toBeNull();
    expect(state.pendingFinal).toBe(false);
    expect(hostApiFetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries authoritative history when a plain-text recruitment final briefly disappears', async () => {
    const { useChatStore } = await import('@/stores/chat');
    const userTimestamp = Date.now();
    const sessionKey = 'agent:employee-recruitment-specialist:test-history-race';
    const runId = '3bf3a75b-938d-419f-abed-0fbb25a140cd';
    const finalReply = [
      '收到！我先整理一下已有信息，并补充几个关键问题：',
      '## 已收集信息',
      '| 岗位名称 | 大模型算法工程师 |',
      '| 工作经验 | 3-5 年 |',
      '请确认岗位类型和岗位职责，或直接说“按这个生成”。',
    ].join('\n\n');
    const staleMessages = [
      { role: 'user', id: 'recruit-user-1', timestamp: userTimestamp - 3, content: '我想要写岗位JD' },
      {
        role: 'assistant',
        id: 'recruit-answer-1',
        timestamp: userTimestamp - 2,
        stopReason: 'stop',
        content: '请提供岗位基本信息。',
      },
      {
        role: 'user',
        id: 'recruit-user-2',
        timestamp: userTimestamp,
        content: '大模型算法工程师，3-5年，硕士及以上，40-60K，深圳',
      },
    ];
    const authoritativeMessages = [
      ...staleMessages,
      {
        role: 'assistant',
        id: 'recruit-authoritative-final',
        timestamp: userTimestamp + 1,
        stopReason: 'stop',
        content: [{ type: 'text', text: finalReply }],
      },
    ];

    hostApiFetchMock
      .mockResolvedValueOnce({ success: true, messages: staleMessages })
      .mockResolvedValueOnce({ success: true, messages: authoritativeMessages });

    useChatStore.setState({
      currentSessionKey: sessionKey,
      currentAgentId: 'employee-recruitment-specialist',
      sessions: [{ key: sessionKey }],
      messages: staleMessages,
      sessionLabels: {},
      sessionLastActivity: {},
      sessionStreamingStates: {},
      sending: true,
      activeRunId: runId,
      streamingText: finalReply,
      streamingMessage: {
        role: 'assistant',
        content: [{ type: 'text', text: finalReply }],
      },
      streamingTools: [],
      pendingFinal: true,
      lastUserMessageAt: userTimestamp,
      pendingToolImages: [],
      error: null,
      runError: null,
      loading: false,
      thinkingLevel: null,
    });

    useChatStore.getState().handleChatEvent({
      state: 'final',
      runId,
      sessionKey,
      message: {
        role: 'assistant',
        timestamp: userTimestamp + 1,
        content: [{ type: 'text', text: finalReply }],
      },
    });

    await vi.waitFor(() => {
      expect(useChatStore.getState().messages.some(
        (message) => message.id === 'recruit-authoritative-final' && extractText(message) === finalReply,
      )).toBe(true);
    });

    expect(useChatStore.getState()).toMatchObject({
      sending: false,
      activeRunId: null,
      pendingFinal: false,
    });
    expect(hostApiFetchMock).toHaveBeenCalledTimes(2);
  });

  it('settles an ambiguous visible text final when backend is idle', async () => {
    const { useChatStore } = await import('@/stores/chat');
    const userTimestamp = Date.now();

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [{ role: 'user', content: 'Generate the DOE report', id: 'u1', timestamp: userTimestamp }],
      sessionLabels: {},
      sessionLastActivity: {},
      sessionStreamingStates: {},
      sending: true,
      activeRunId: 'run-visible-no-stop',
      streamingText: '',
      streamingMessage: { role: 'assistant', content: [{ type: 'text', text: 'Preparing final report.' }] },
      streamingTools: [],
      pendingFinal: true,
      lastUserMessageAt: userTimestamp,
      pendingToolImages: [],
      error: null,
      loading: false,
      thinkingLevel: null,
    });

    useChatStore.getState().handleChatEvent({
      state: 'final',
      runId: 'run-visible-no-stop',
      sessionKey: 'agent:main:main',
      message: {
        role: 'assistant',
        id: 'final-visible-no-stop',
        timestamp: userTimestamp + 1,
        content: [{ type: 'text', text: 'DOE report is ready. Please review the generated files.' }],
      },
    });

    await vi.waitFor(() => {
      expect(useChatStore.getState().sending).toBe(false);
    });

    const state = useChatStore.getState();
    expect(state.activeRunId).toBeNull();
    expect(state.pendingFinal).toBe(false);
    expect(state.streamingMessage).toBeNull();
    expect(extractText(state.messages.find((message) => message.id === 'final-visible-no-stop'))).toContain(
      'DOE report is ready',
    );
  });
  it('keeps a final carrying an actual tool call active', async () => {
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [{ role: 'user', content: 'Check my calendar' }],
      sessionLabels: {},
      sessionLastActivity: {},
      sessionStreamingStates: {},
      sending: true,
      activeRunId: 'run-tool-step',
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: 123,
      pendingToolImages: [],
      error: null,
      loading: false,
      thinkingLevel: null,
    });

    useChatStore.getState().handleChatEvent({
      state: 'final',
      runId: 'run-tool-step',
      sessionKey: 'agent:main:main',
      message: {
        role: 'assistant',
        id: 'tool-step',
        stopReason: 'toolUse',
        content: [
          { type: 'text', text: 'Querying the calendar now.' },
          { type: 'toolCall', id: 'call-1', name: 'exec', arguments: { command: 'query-events' } },
        ],
      },
    });

    const state = useChatStore.getState();
    expect(state.sending).toBe(true);
    expect(state.activeRunId).toBe('run-tool-step');
    expect(state.pendingFinal).toBe(true);
    expect(extractText(state.messages.at(-1))).toContain('Querying the calendar now');
  });

  it('keeps run active for narration-only interim finals between tool rounds', async () => {
    const { useChatStore } = await import('@/stores/chat');
    getSessionBackendActivityMock.mockResolvedValueOnce({
      success: true,
      session: {
        sessionKey: 'agent:main:main',
        status: 'processing',
        processing: true,
        hasTrackedUserRun: true,
        activeRunIds: ['run-narration-gap'],
      },
      background: {
        hasBackgroundProcessing: false,
        processingSessionKeys: [],
      },
    });

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [{ role: 'user', content: 'Analyze the repo' }],
      sessionLabels: {},
      sessionLastActivity: {},
      sessionStreamingStates: {},
      sending: true,
      activeRunId: 'run-narration-gap',
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: 123,
      pendingToolImages: [],
      error: null,
      loading: false,
      thinkingLevel: null,
    });

    useChatStore.getState().handleChatEvent({
      state: 'final',
      runId: 'run-narration-gap',
      sessionKey: 'agent:main:main',
      message: {
        role: 'assistant',
        id: 'narration-gap',
        content: [{ type: 'text', text: 'Scanning the repository structure.' }],
      },
    });

    const state = useChatStore.getState();
    expect(state.sending).toBe(true);
    expect(state.activeRunId).toBe('run-narration-gap');
    expect(state.pendingFinal).toBe(true);
  });

  it('reconciles an ambiguous text final with a terminal transcript after tool use', async () => {
    const { useChatStore } = await import('@/stores/chat');
    const userTimestamp = Date.now();

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [
        { role: 'user', content: 'Export the deck', id: 'user-1', timestamp: userTimestamp },
        {
          role: 'assistant',
          id: 'tool-use-1',
          content: [
            { type: 'text', text: 'Exporting the deck.' },
            { type: 'tool_use', id: 'call-1', name: 'exec', input: { command: 'export-ppt' } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'deck.pptx' }],
        },
      ],
      sessionLabels: {},
      sessionLastActivity: {},
      sessionStreamingStates: {},
      sending: true,
      activeRunId: 'run-ppt-export',
      streamingText: '',
      streamingMessage: { role: 'assistant', content: [{ type: 'text', text: 'Preparing final report.' }] },
      streamingTools: [],
      pendingFinal: true,
      lastUserMessageAt: userTimestamp,
      pendingToolImages: [],
      error: null,
      loading: false,
      thinkingLevel: null,
    });

    hostApiFetchMock.mockResolvedValueOnce({
      success: true,
      messages: [
        { role: 'user', content: 'Export the deck', id: 'user-1', timestamp: userTimestamp },
        {
          role: 'assistant',
          id: 'final-report',
          timestamp: userTimestamp + 1,
          stopReason: 'stop',
          content: [{ type: 'text', text: 'PPT generated successfully: deck.pptx' }],
        },
      ],
    });

    useChatStore.getState().handleChatEvent({
      state: 'final',
      runId: 'run-ppt-export',
      sessionKey: 'agent:main:main',
      message: {
        role: 'assistant',
        id: 'final-report',
        content: [{ type: 'text', text: 'PPT generated successfully: deck.pptx' }],
      },
    });

    await vi.waitFor(() => {
      expect(useChatStore.getState().sending).toBe(false);
    });

    const state = useChatStore.getState();
    expect(state.activeRunId).toBeNull();
    expect(state.pendingFinal).toBe(false);
    expect(state.streamingMessage).toBeNull();
    expect(extractText(state.messages.find((message) => message.id === 'final-report'))).toContain(
      'PPT generated successfully',
    );
  });

  it('settles foreground state from a bound announce final even when the run id differs', async () => {
    const { useChatStore } = await import('@/stores/chat');
    const userTimestamp = Date.now();
    const sessionKey = 'agent:main:session-announce';
    const childSessionKey = 'agent:main:subagent:child-123';
    const announceRunId = `announce:v1:${childSessionKey}:child-run-1`;

    useChatStore.setState({
      currentSessionKey: sessionKey,
      currentAgentId: 'main',
      sessions: [{ key: sessionKey }],
      messages: [
        { role: 'user', content: 'Generate DOE PPT', id: 'user-announce', timestamp: userTimestamp },
        {
          role: 'assistant',
          id: 'spawn-assistant',
          content: [{ type: 'tool_use', id: 'spawn-1', name: 'sessions_spawn', input: { task: 'Generate DOE PPT' } }],
          stopReason: 'toolUse',
          timestamp: userTimestamp + 1,
        },
        {
          role: 'toolResult',
          id: 'spawn-result',
          toolCallId: 'spawn-1',
          content: [{
            type: 'text',
            text: JSON.stringify({ status: 'accepted', childSessionKey, runId: 'child-run-1' }),
          }],
          timestamp: userTimestamp + 2,
        },
      ],
      sessionLabels: {},
      sessionLastActivity: {},
      sessionStreamingStates: {},
      sending: true,
      activeRunId: 'parent-run-1',
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: true,
      lastUserMessageAt: userTimestamp,
      pendingToolImages: [],
      error: null,
      runError: null,
      loading: false,
      thinkingLevel: null,
      gatewayBackgroundActivity: { hasBackgroundProcessing: false, processingSessionKeys: [] },
      sessionBackendActivity: {
        sessionKey,
        status: 'idle',
        processing: false,
        hasTrackedUserRun: false,
        activeRunIds: [],
      },
    });

    useChatStore.getState().handleChatEvent({
      state: 'final',
      runId: announceRunId,
      sessionKey,
      message: {
        role: 'assistant',
        id: 'announce-final',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'DOE PPT generated successfully.' }],
      },
    });

    await vi.waitFor(() => {
      expect(useChatStore.getState().sending).toBe(false);
    });

    const state = useChatStore.getState();
    expect(state.activeRunId).toBeNull();
    expect(state.pendingFinal).toBe(false);
    expect(state.streamingMessage).toBeNull();
    expect(extractText(state.messages.find((message) => message.id === 'announce-final'))).toContain('DOE PPT generated');
  });

  it('does not clear foreground state from an unbound announce final', async () => {
    const { useChatStore } = await import('@/stores/chat');
    const userTimestamp = Date.now();
    const sessionKey = 'agent:main:session-announce-unbound';
    const announceRunId = 'announce:v1:agent:main:subagent:other-child:child-run-1';

    useChatStore.setState({
      currentSessionKey: sessionKey,
      currentAgentId: 'main',
      sessions: [{ key: sessionKey }],
      messages: [
        { role: 'user', content: 'Generate DOE PPT', id: 'user-announce-unbound', timestamp: userTimestamp },
      ],
      sessionLabels: {},
      sessionLastActivity: {},
      sessionStreamingStates: {},
      sending: true,
      activeRunId: 'parent-run-unbound',
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: true,
      lastUserMessageAt: userTimestamp,
      pendingToolImages: [],
      error: null,
      runError: null,
      loading: false,
      thinkingLevel: null,
      gatewayBackgroundActivity: { hasBackgroundProcessing: false, processingSessionKeys: [] },
      sessionBackendActivity: {
        sessionKey,
        status: 'idle',
        processing: false,
        hasTrackedUserRun: false,
        activeRunIds: [],
      },
    });

    useChatStore.getState().handleChatEvent({
      state: 'final',
      runId: announceRunId,
      sessionKey,
      message: {
        role: 'assistant',
        id: 'unbound-announce-final',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'Unrelated child finished.' }],
      },
    });

    await Promise.resolve();

    const state = useChatStore.getState();
    expect(state.sending).toBe(true);
    expect(state.activeRunId).toBe('parent-run-unbound');
    expect(state.pendingFinal).toBe(true);
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
