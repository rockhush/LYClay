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
  },
}));

vi.mock('@/stores/agents', () => ({
  useAgentsStore: {
    getState: () => agentsState,
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
      success: false,
      session: {
        sessionKey: 'agent:main:main',
        status: null,
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

    const state = useChatStore.getState();
    expect(state.sending).toBe(false);
    expect(state.activeRunId).toBeNull();
    expect(state.pendingFinal).toBe(false);
    expect(state.streamingMessage).toBeNull();
    expect(extractText(state.messages.at(-1))).toBe('PPT generated successfully.');
  });

  it('clears a same-run empty final only after backend is idle', async () => {
    const { useChatStore } = await import('@/stores/chat');

    hostApiFetchMock.mockResolvedValue({ success: false, messages: [], error: 'local miss' });
    getSessionBackendActivityMock.mockResolvedValue({
      success: true,
      session: {
        sessionKey: 'agent:main:main',
        status: 'idle',
        processing: false,
        hasTrackedUserRun: false,
        activeRunIds: [],
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

    await vi.waitFor(() => expect(useChatStore.getState().sending).toBe(false));
    expect(useChatStore.getState().activeRunId).toBeNull();
    expect(useChatStore.getState().pendingFinal).toBe(false);
    expect(getSessionBackendActivityMock).toHaveBeenCalledWith('agent:main:main');
  });

  it('keeps a same-run empty final active while backend still tracks work', async () => {
    const { useChatStore } = await import('@/stores/chat');

    hostApiFetchMock.mockResolvedValue({ success: false, messages: [], error: 'local miss' });
    getSessionBackendActivityMock.mockResolvedValue({
      success: true,
      session: {
        sessionKey: 'agent:main:main',
        status: 'processing',
        processing: true,
        hasTrackedUserRun: true,
        activeRunIds: ['run-empty-final-active'],
      },
      background: {
        hasBackgroundProcessing: true,
        processingSessionKeys: ['agent:main:main'],
      },
    });

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

    await vi.waitFor(() => expect(getSessionBackendActivityMock).toHaveBeenCalledWith('agent:main:main'));
    expect(useChatStore.getState().sending).toBe(true);
    expect(useChatStore.getState().activeRunId).toBe('run-empty-final-active');
    expect(useChatStore.getState().pendingFinal).toBe(true);
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

    const state = useChatStore.getState();
    expect(state.sending).toBe(false);
    expect(state.activeRunId).toBeNull();
    expect(state.pendingFinal).toBe(false);
    expect(extractText(state.messages.at(-1))).toContain('Installing it now');
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
