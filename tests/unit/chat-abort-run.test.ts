import { beforeEach, describe, expect, it, vi } from 'vitest';

const { gatewayRpcMock, hostApiFetchMock, getSessionBackendActivityMock, agentsState } = vi.hoisted(() => ({
  gatewayRpcMock: vi.fn(),
  hostApiFetchMock: vi.fn(),
  getSessionBackendActivityMock: vi.fn(),
  agentsState: {
    agents: [] as Array<Record<string, unknown>>,
  },
}));

const idleBackendActivityResponse = () => ({
  success: true,
  session: {
    sessionKey: 'agent:main:main',
    status: 'idle',
    processing: false,
    hasTrackedUserRun: false,
    activeRunIds: [] as string[],
  },
  background: { hasBackgroundProcessing: false, processingSessionKeys: [] as string[] },
});

vi.mock('@/stores/gateway', () => {
  const useGatewayStore = Object.assign(
    (selector: (state: { status: { state: string; port: number }; rpc: typeof gatewayRpcMock }) => unknown) =>
      selector({ status: { state: 'running', port: 18789 }, rpc: gatewayRpcMock }),
    {
      getState: () => ({
        status: { state: 'running', port: 18789 },
        rpc: gatewayRpcMock,
      }),
      subscribe: vi.fn(() => vi.fn()),
    },
  );
  return { useGatewayStore };
});

vi.mock('@/stores/agents', () => ({
  useAgentsStore: {
    getState: () => agentsState,
  },
}));

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
  getSessionBackendActivity: (...args: unknown[]) => getSessionBackendActivityMock(...args),
}));

vi.mock('@/lib/ui-state-persistence', () => ({
  flushUiStateSync: vi.fn(async () => undefined),
  hydrateUiStateFromDisk: vi.fn(async () => undefined),
}));

describe('chat abort run', () => {
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
    gatewayRpcMock.mockResolvedValue({ ok: true });
    getSessionBackendActivityMock.mockResolvedValue(idleBackendActivityResponse());
  });

  it('ignores late delta events after the user aborts a run', async () => {
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: true,
      activeRunId: 'run-abort-me',
      streamingText: '',
      streamingMessage: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Partial output' }],
      },
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: Date.now(),
      pendingToolImages: [],
      error: null,
      loading: false,
      thinkingLevel: null,
      runAborted: false,
    });

    await useChatStore.getState().abortRun();

    expect(useChatStore.getState().sending).toBe(false);
    expect(useChatStore.getState().activeRunId).toBeNull();
    expect(useChatStore.getState().runAborted).toBe(true);
    expect(gatewayRpcMock).toHaveBeenCalledWith(
      'sessions.abort',
      expect.objectContaining({
        key: 'agent:main:main',
        runId: 'run-abort-me',
      }),
      expect.anything(),
    );

    useChatStore.getState().handleChatEvent({
      state: 'delta',
      runId: 'run-abort-me',
      sessionKey: 'agent:main:main',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'This should not appear after abort.' }],
      },
    });

    expect(useChatStore.getState().streamingMessage).toBeNull();
    expect(useChatStore.getState().sending).toBe(false);
  });

  it('suppresses the "system interrupted" banner on user stop even when the aborted runId does not match', async () => {
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: true,
      activeRunId: 'run-parent',
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: Date.now(),
      pendingToolImages: [],
      error: null,
      runError: null,
      loading: false,
      thinkingLevel: null,
      runAborted: false,
    });

    await useChatStore.getState().abortRun();

    // The terminal `aborted` event arrives for a DIFFERENT run id (e.g. a child
    // subagent / announce wrap-up run), so the exact run-id match fails — the
    // broader user-stop signals (runAborted / abort window) must still suppress.
    useChatStore.getState().handleChatEvent({
      state: 'aborted',
      runId: 'run-child-xyz',
      sessionKey: 'agent:main:main',
    });

    expect(useChatStore.getState().runError).toBeNull();
    expect(useChatStore.getState().error).toBeNull();
    expect(useChatStore.getState().sending).toBe(false);
  });

  it('still surfaces the banner for a genuine system abort (no user-stop signal)', async () => {
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: true,
      activeRunId: 'run-sys',
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: Date.now(),
      pendingToolImages: [],
      error: null,
      runError: null,
      loading: false,
      thinkingLevel: null,
      runAborted: false,
    });

    useChatStore.getState().handleChatEvent({
      state: 'aborted',
      runId: 'run-sys',
      sessionKey: 'agent:main:main',
    });

    expect(useChatStore.getState().runError).toBeTruthy();
    expect(useChatStore.getState().runAborted).toBe(true);
  });

  it('does not surface a task error when a subagent announce wrap-up run fails', async () => {
    const { useChatStore } = await import('@/stores/chat');

    const announceRunId =
      'announce:v1:agent:main:subagent:820258e6-a42b-4140-a0a8-569704c34582:b62d548c-46c7-4b8d-bf76-e2c212561cde';

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: true,
      // The auto-announce wrap-up is the active run when it fails.
      activeRunId: announceRunId,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: Date.now(),
      pendingToolImages: [],
      error: null,
      runError: null,
      loading: false,
      thinkingLevel: null,
      runAborted: false,
    });

    // The child already completed (file produced); only the supplementary
    // announce summary failed with the OpenClaw continuation error. This must
    // finalize cleanly instead of showing a red "Run ended" task-failure banner.
    useChatStore.getState().handleChatEvent({
      state: 'error',
      runId: announceRunId,
      sessionKey: 'agent:main:main',
      errorMessage: 'Cannot continue from message role: assistant',
    });

    expect(useChatStore.getState().error).toBeNull();
    expect(useChatStore.getState().runError).toBeNull();
    expect(useChatStore.getState().sending).toBe(false);
    expect(useChatStore.getState().activeRunId).toBeNull();
  });

  it('does not re-adopt a persisted user-aborted session after a simulated restart', async () => {
    const { useChatStore } = await import('@/stores/chat');
    const { isUserAbortedSession } = await import('@/stores/chat/user-aborted-sessions');

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: true,
      activeRunId: 'run-restart-me',
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: Date.now(),
      pendingToolImages: [],
      error: null,
      loading: false,
      thinkingLevel: null,
      runAborted: false,
    });

    await useChatStore.getState().abortRun();
    expect(isUserAbortedSession('agent:main:main')).toBe(true);

    useChatStore.setState({
      sending: false,
      activeRunId: null,
      runAborted: false,
      streamingMessage: null,
    });

    useChatStore.getState().handleChatEvent({
      state: 'started',
      runId: 'run-restart-me',
      sessionKey: 'agent:main:main',
    });

    expect(useChatStore.getState().sending).toBe(false);
    expect(useChatStore.getState().activeRunId).toBeNull();
  });

  it('resolves runId from backend activity when aborting before activeRunId is synced', async () => {
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: true,
      activeRunId: null,
      sessionBackendActivity: {
        sessionKey: 'agent:main:main',
        status: 'running',
        processing: true,
        hasTrackedUserRun: true,
        activeRunIds: ['run-backend-only'],
      },
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: Date.now(),
      pendingToolImages: [],
      error: null,
      loading: false,
      thinkingLevel: null,
      runAborted: false,
    });

    await useChatStore.getState().abortRun();

    expect(gatewayRpcMock).toHaveBeenCalledWith(
      'sessions.abort',
      expect.objectContaining({
        key: 'agent:main:main',
        runId: 'run-backend-only',
      }),
      expect.anything(),
    );
  });

  it('marks the run aborted before waiting on backend activity refresh', async () => {
    const { useChatStore } = await import('@/stores/chat');
    const { isUserAbortedSession } = await import('@/stores/chat/user-aborted-sessions');

    let resolveBackend: ((value: unknown) => void) | undefined;
    getSessionBackendActivityMock.mockReset();
    getSessionBackendActivityMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveBackend = resolve;
    }));
    getSessionBackendActivityMock.mockResolvedValue(idleBackendActivityResponse());

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: true,
      activeRunId: null,
      sessionBackendActivity: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: Date.now(),
      pendingToolImages: [],
      error: null,
      loading: false,
      thinkingLevel: null,
      runAborted: false,
    });

    const abortPromise = useChatStore.getState().abortRun();

    expect(useChatStore.getState().runAborted).toBe(true);
    expect(useChatStore.getState().sending).toBe(false);
    expect(isUserAbortedSession('agent:main:main')).toBe(true);

    resolveBackend?.({
      success: true,
      session: {
        sessionKey: 'agent:main:main',
        status: 'running',
        processing: true,
        hasTrackedUserRun: true,
        activeRunIds: ['run-late-backend'],
      },
      background: { hasBackgroundProcessing: false, processingSessionKeys: [] },
    });

    await abortPromise;

    expect(gatewayRpcMock).toHaveBeenCalledWith(
      'sessions.abort',
      expect.objectContaining({
        key: 'agent:main:main',
        runId: 'run-late-backend',
      }),
      expect.anything(),
    );
  });

  it('does not re-adopt after user abort when an intermediate final arrives', async () => {
    const { useChatStore } = await import('@/stores/chat');
    const { isUserAbortedSession } = await import('@/stores/chat/user-aborted-sessions');

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: true,
      activeRunId: 'run-tool-round',
      streamingText: '',
      streamingMessage: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Reading skill...' }],
      },
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: Date.now(),
      pendingToolImages: [],
      error: null,
      loading: false,
      thinkingLevel: null,
      runAborted: false,
    });

    await useChatStore.getState().abortRun();
    expect(isUserAbortedSession('agent:main:main')).toBe(true);

    useChatStore.getState().handleChatEvent({
      state: 'final',
      runId: 'run-tool-round',
      sessionKey: 'agent:main:main',
      message: {
        role: 'toolresult',
        content: 'tool output',
        toolCallId: 'tool-1',
      },
    });

    expect(isUserAbortedSession('agent:main:main')).toBe(true);
    expect(useChatStore.getState().sending).toBe(false);
    expect(useChatStore.getState().pendingFinal).toBe(false);
    expect(useChatStore.getState().runAborted).toBe(true);

    useChatStore.getState().handleChatEvent({
      state: 'started',
      runId: 'run-tool-round',
      sessionKey: 'agent:main:main',
    });

    expect(useChatStore.getState().sending).toBe(false);
    expect(useChatStore.getState().activeRunId).toBeNull();
  });

  it('keeps the session non-executing after aborted event while backend is still winding down', async () => {
    const { useChatStore } = await import('@/stores/chat');
    const { deriveIsExecuting } = await import('@/stores/chat/user-turn-lifecycle');
    const { isUserAbortedSession } = await import('@/stores/chat/user-aborted-sessions');

    getSessionBackendActivityMock.mockResolvedValue({
      success: true,
      session: {
        sessionKey: 'agent:main:main',
        status: 'running',
        processing: true,
        hasTrackedUserRun: true,
        activeRunIds: ['run-still-active'],
      },
      background: { hasBackgroundProcessing: false, processingSessionKeys: [] },
    });

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [{ role: 'user', content: 'hello', timestamp: 1, id: 'u1' }],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: true,
      activeRunId: 'run-still-active',
      streamingText: '',
      streamingMessage: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Working...' }],
      },
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: Date.now(),
      pendingToolImages: [],
      error: null,
      loading: false,
      thinkingLevel: null,
      runAborted: false,
    });

    await useChatStore.getState().abortRun();

    useChatStore.getState().handleChatEvent({
      state: 'aborted',
      runId: 'run-still-active',
      sessionKey: 'agent:main:main',
    });

    const state = useChatStore.getState();
    expect(isUserAbortedSession('agent:main:main')).toBe(true);
    expect(state.sending).toBe(false);
    expect(state.runAborted).toBe(true);
    expect(deriveIsExecuting(
      { sending: state.sending, activeRunId: state.activeRunId, pendingFinal: state.pendingFinal, runAborted: state.runAborted },
      state.sessionBackendActivity,
      {
        gatewayBackground: state.gatewayBackgroundActivity,
        messages: state.messages,
        lastUserMessageAt: state.lastUserMessageAt,
        sessionKey: 'agent:main:main',
      },
    )).toBe(false);

    useChatStore.getState().handleChatEvent({
      state: 'delta',
      runId: 'run-still-active',
      sessionKey: 'agent:main:main',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Should not resume streaming.' }],
      },
    });

    expect(useChatStore.getState().streamingMessage).toBeNull();
    expect(useChatStore.getState().sending).toBe(false);
  });

  it('keeps the persisted abort marker after backend reports idle post-abort', async () => {
    const { useChatStore } = await import('@/stores/chat');
    const { isUserAbortedSession } = await import('@/stores/chat/user-aborted-sessions');

    getSessionBackendActivityMock.mockResolvedValue(idleBackendActivityResponse());

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [{ role: 'user', content: 'hello', timestamp: 1, id: 'u1' }],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: true,
      activeRunId: 'run-abort-me',
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: Date.now(),
      pendingToolImages: [],
      error: null,
      loading: false,
      thinkingLevel: null,
      runAborted: false,
    });

    await useChatStore.getState().abortRun();

    expect(isUserAbortedSession('agent:main:main')).toBe(true);
    expect(useChatStore.getState().runAborted).toBe(true);
    expect(useChatStore.getState().sending).toBe(false);

    useChatStore.getState().handleChatEvent({
      state: 'started',
      runId: 'run-late-restart',
      sessionKey: 'agent:main:main',
    });

    expect(isUserAbortedSession('agent:main:main')).toBe(true);
    expect(useChatStore.getState().runAborted).toBe(true);
    expect(useChatStore.getState().sending).toBe(false);
    expect(useChatStore.getState().activeRunId).toBeNull();
  });

  it('kickSessionBackendPolling restores the abort shield after a simulated restart', async () => {
    const { useChatStore, kickSessionBackendPolling } = await import('@/stores/chat');
    const { persistUserAbortedSession } = await import('@/stores/chat/user-aborted-sessions');

    persistUserAbortedSession('agent:main:main', 'run-stale');

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      sending: true,
      activeRunId: 'run-stale',
      runAborted: false,
      pendingFinal: true,
    });

    kickSessionBackendPolling();

    expect(useChatStore.getState().sending).toBe(false);
    expect(useChatStore.getState().activeRunId).toBeNull();
    expect(useChatStore.getState().runAborted).toBe(true);
  });
});
