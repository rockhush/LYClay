import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { gatewayRpcMock, hostApiFetchMock, getSessionBackendActivityMock, agentsState, digitalEmployeesState } = vi.hoisted(() => ({
  gatewayRpcMock: vi.fn(),
  hostApiFetchMock: vi.fn(),
  getSessionBackendActivityMock: vi.fn(),
  agentsState: {
    agents: [] as Array<Record<string, unknown>>,
  },
  digitalEmployeesState: {
    employees: [] as Array<Record<string, unknown>>,
  },
}));

vi.mock('@/stores/gateway', () => ({
  useGatewayStore: {
    getState: () => ({
      rpc: gatewayRpcMock,
      status: { gatewayReady: true },
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
    getState: () => digitalEmployeesState,
  },
}));

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
  getSessionBackendActivity: (...args: unknown[]) => getSessionBackendActivityMock(...args),
}));

vi.mock('@/lib/ui-state-persistence', () => ({
  hydrateUiStateFromDisk: vi.fn().mockResolvedValue(undefined),
  persistUiStateSoon: vi.fn(),
}));

describe('chat target routing', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-11T12:00:00Z'));
    window.localStorage.clear();

    agentsState.agents = [
      {
        id: 'main',
        name: 'Main',
        isDefault: true,
        modelDisplay: 'MiniMax',
        inheritedModel: true,
        workspace: '~/.openclaw/workspace',
        agentDir: '~/.openclaw/agents/main/agent',
        mainSessionKey: 'agent:main:main',
        channelTypes: [],
      },
      {
        id: 'research',
        name: 'Research',
        isDefault: false,
        isDigitalEmployee: true,
        digitalEmployeeInstanceId: 'research--local',
        digitalEmployeeInstallPath: 'C:\\Users\\test\\.openclaw\\digital-employees\\research--local',
        modelDisplay: 'Claude',
        inheritedModel: false,
        workspace: '~/.openclaw/workspace-research',
        agentDir: '~/.openclaw/agents/research/agent',
        mainSessionKey: 'agent:research:desk',
        channelTypes: [],
      },
    ];
    digitalEmployeesState.employees = [];

    gatewayRpcMock.mockReset();
    gatewayRpcMock.mockImplementation(async (method: string) => {
      if (method === 'chat.history') {
        return { messages: [] };
      }
      if (method === 'chat.send') {
        return { runId: 'run-text' };
      }
      if (method === 'sessions.patch') {
        return { ok: true };
      }
      if (method === 'sessions.abort') {
        return { ok: true };
      }
      if (method === 'sessions.list') {
        return { sessions: [] };
      }
      throw new Error(`Unexpected gateway RPC: ${method}`);
    });

    hostApiFetchMock.mockReset();
    hostApiFetchMock.mockResolvedValue({ success: true, result: { runId: 'run-media' } });
    getSessionBackendActivityMock.mockReset();
    getSessionBackendActivityMock.mockImplementation(async (sessionKey: string) => ({
      success: true,
      session: {
        sessionKey,
        status: 'completed',
        processing: false,
        hasTrackedUserRun: false,
        activeRunIds: [],
      },
      background: {
        hasBackgroundProcessing: false,
        processingSessionKeys: [],
      },
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('executes a selected digital employee in the current session for text sends', async () => {
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [{ role: 'assistant', content: 'Existing main history' }],
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

    await useChatStore.getState().sendMessage('Hello direct agent', undefined, 'research');

    const state = useChatStore.getState();
    expect(state.currentSessionKey).toBe('agent:main:main');
    expect(state.currentAgentId).toBe('main');
    expect(state.messages.at(-1)?.content).toBe('Hello direct agent');
    expect(state.messages.at(-1)?._agentMentionName).toBe('Research');

    const historyCall = gatewayRpcMock.mock.calls.find(([method]) => method === 'chat.history');
    expect(historyCall).toBeUndefined();

    const sendCall = gatewayRpcMock.mock.calls.find(([method]) => method === 'chat.send');
    expect(sendCall?.[1]).toMatchObject({
      sessionKey: 'agent:main:main',
      message: '/think off Hello direct agent',
      deliver: false,
      executeAsAgentId: 'research',
      executedByAgentName: 'Research',
    });
    expect(gatewayRpcMock.mock.calls.find(([method]) => method === 'sessions.patch')).toBeUndefined();
    expect(typeof (sendCall?.[1] as { idempotencyKey?: unknown })?.idempotencyKey).toBe('string');

    useChatStore.setState({ sending: false, activeRunId: null });
    await vi.advanceTimersByTimeAsync(5_000);
    const patchCall = gatewayRpcMock.mock.calls.find(([method]) => method === 'sessions.patch');
    expect(patchCall?.[1]).toEqual({ key: 'agent:main:main', thinkingLevel: 'off' });
  });

  it('executes reactivated historical digital employee sessions via the reinstalled agent id', async () => {
    const { loadRetiredDigitalEmployees } = await import('@/lib/retired-digital-employees');
    loadRetiredDigitalEmployees({
      retiredAgents: {
        'employee-recruitment-specialist-8dce23b0': {
          agentId: 'employee-recruitment-specialist-8dce23b0',
          name: '招聘数字员工',
          marketEmployeeId: 'employee-recruitment-specialist',
          retiredAt: '2026-03-11T12:00:00Z',
          readOnly: false,
        },
      },
    });

    agentsState.agents = [
      agentsState.agents[0],
      {
        id: 'employee-recruitment-specialist-newid01',
        name: '招聘数字员工',
        isDefault: false,
        isDigitalEmployee: true,
        digitalEmployeeInstanceId: 'recruitment--new',
        digitalEmployeeInstallPath: 'C:\\Users\\test\\.openclaw\\digital-employees\\recruitment--new',
        modelDisplay: 'Claude',
        inheritedModel: false,
        workspace: '~/.openclaw/workspace-recruitment',
        agentDir: '~/.openclaw/agents/employee-recruitment-specialist-newid01/agent',
        mainSessionKey: 'agent:employee-recruitment-specialist-newid01:main',
        channelTypes: [],
      },
    ];
    digitalEmployeesState.employees = [{
      instanceId: 'recruitment--new',
      marketEmployeeId: 'employee-recruitment-specialist',
      packageId: 'employee-recruitment-specialist',
      packageVersion: '1.0.0',
      name: '招聘数字员工',
      description: '招聘助手',
      tags: [],
      installPath: 'C:\\Users\\test\\.openclaw\\digital-employees\\recruitment--new',
      agentId: 'employee-recruitment-specialist-newid01',
      sessionKey: 'agent:employee-recruitment-specialist-newid01:main',
      status: 'active',
      enabled: true,
      warnings: [],
    }];

    const { useChatStore } = await import('@/stores/chat');
    const historicalSessionKey = 'agent:employee-recruitment-specialist-8dce23b0:main';

    useChatStore.setState({
      currentSessionKey: historicalSessionKey,
      currentAgentId: 'employee-recruitment-specialist-8dce23b0',
      sessions: [{ key: historicalSessionKey }],
      messages: [{ role: 'assistant', content: '历史会话内容' }],
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

    await useChatStore.getState().sendMessage('继续帮我分析候选人');

    const state = useChatStore.getState();
    expect(state.currentSessionKey).toBe(historicalSessionKey);
    expect(state.currentAgentId).toBe('employee-recruitment-specialist-8dce23b0');
    expect(state.error).toBeNull();

    const sendCall = gatewayRpcMock.mock.calls.find(([method]) => method === 'chat.send');
    expect(sendCall?.[1]).toMatchObject({
      sessionKey: historicalSessionKey,
      message: '/think off 继续帮我分析候选人',
      deliver: false,
      executeAsAgentId: 'employee-recruitment-specialist-newid01',
      executedByAgentName: '招聘数字员工',
    });
  });

  it('clears stale active run and tool state before sending a new message', async () => {
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [{ role: 'assistant', content: 'old answer' }],
      sessionLabels: {},
      sessionLastActivity: {},
      sessionStreamingStates: {
        'agent:main:main': {
          activeRunId: 'old-ppt-run',
          activeTool: {
            runId: 'old-ppt-run',
            toolCallId: 'call-ppt',
            name: 'exec',
            status: 'running',
            startedAt: Date.now() - 60_000,
            lastActivityAt: Date.now() - 30_000,
          },
          streamingText: 'creating ppt',
          streamingMessage: { role: 'assistant', content: 'creating ppt' },
          streamingTools: [{ id: 'call-ppt', name: 'exec', status: 'running' }],
          pendingFinal: true,
          lastUserMessageAt: Date.now() - 60_000,
          pendingToolImages: [{ toolCallId: 'call-ppt', path: 'old.png' }],
          runAborted: false,
          runError: null,
          sending: false,
          messagesSnapshot: [{ role: 'assistant', content: 'old answer' }],
        },
      },
      sending: false,
      activeRunId: 'old-ppt-run',
      activeTool: {
        runId: 'old-ppt-run',
        toolCallId: 'call-ppt',
        name: 'exec',
        status: 'running',
        startedAt: Date.now() - 60_000,
        lastActivityAt: Date.now() - 30_000,
      },
      streamingText: 'creating ppt',
      streamingMessage: { role: 'assistant', content: 'creating ppt' },
      streamingTools: [{ id: 'call-ppt', name: 'exec', status: 'running' }],
      pendingFinal: true,
      lastUserMessageAt: Date.now() - 60_000,
      pendingToolImages: [{ toolCallId: 'call-ppt', path: 'old.png' }],
      error: null,
      runError: 'Run interrupted because the Gateway restarted.',
      loading: false,
      thinkingLevel: null,
    });

    await useChatStore.getState().sendMessage('介绍一下湖南');

    const state = useChatStore.getState();
    expect(state.activeRunId).toBe('run-text');
    expect(state.activeTool).toBeNull();
    expect(state.streamingTools).toEqual([]);
    expect(state.streamingText).toBe('');
    expect(state.streamingMessage).toBeNull();
    expect(state.pendingToolImages).toEqual([]);
    expect(state.runError).toBeNull();

    const cached = state.sessionStreamingStates['agent:main:main'];
    expect(cached.activeRunId).toBe('run-text');
    expect(cached.activeTool).toBeNull();
    expect(cached.streamingTools).toEqual([]);
    expect(cached.streamingText).toBe('');
    expect(cached.streamingMessage).toBeNull();
    expect(cached.pendingToolImages).toEqual([]);
    expect(cached.messagesSnapshot.at(-1)?.content).toBe('介绍一下湖南');
  });

  it('does not duplicate the user bubble when silently retrying a tool stream error', async () => {
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
      reasoningMode: 'fast',
    });

    await useChatStore.getState().sendMessage('retry task');
    const sessionKey = useChatStore.getState().currentSessionKey;

    useChatStore.getState().handleChatEvent({
      state: 'error',
      runId: 'run-text',
      sessionKey,
      errorMessage: 'list index out of range',
    });

    await vi.advanceTimersByTimeAsync(100);
    await Promise.resolve();

    const chatSendCalls = gatewayRpcMock.mock.calls.filter(([method]) => method === 'chat.send');
    expect(chatSendCalls).toHaveLength(2);
    expect(useChatStore.getState().messages.filter((message) => message.role === 'user')).toHaveLength(1);
    expect(useChatStore.getState().messages.at(-1)?.content).toBe('retry task');
  });

  it('keeps a pending silent retry alive when the retry abort emits aborted before the timer fires', async () => {
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
      reasoningMode: 'fast',
    });

    await useChatStore.getState().sendMessage('retry after abort');
    const sessionKey = useChatStore.getState().currentSessionKey;

    useChatStore.getState().handleChatEvent({
      state: 'error',
      runId: 'run-text',
      sessionKey,
      errorMessage: 'list index out of range',
    });

    useChatStore.getState().handleChatEvent({
      state: 'aborted',
      runId: 'run-text',
      sessionKey,
    });

    expect(useChatStore.getState().sending).toBe(true);

    await vi.advanceTimersByTimeAsync(100);
    await Promise.resolve();

    const chatSendCalls = gatewayRpcMock.mock.calls.filter(([method]) => method === 'chat.send');
    expect(chatSendCalls).toHaveLength(2);
    expect(useChatStore.getState().messages.filter((message) => message.role === 'user')).toHaveLength(1);
    expect(useChatStore.getState().messages.at(-1)?.content).toBe('retry after abort');
  });

  it('finalizes a terminal tool stream error immediately when no silent retry is available', async () => {
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: true,
      activeRunId: 'run-terminal-error',
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: true,
      lastUserMessageAt: Date.now(),
      pendingToolImages: [],
      error: null,
      loading: false,
      thinkingLevel: null,
    });

    useChatStore.getState().handleChatEvent({
      state: 'error',
      runId: 'run-terminal-error',
      sessionKey: 'agent:main:main',
      errorMessage: 'list index out of range',
    });

    const state = useChatStore.getState();
    expect(state.sending).toBe(false);
    expect(state.activeRunId).toBeNull();
    expect(state.pendingFinal).toBe(false);
    expect(state.error).toBe('list index out of range');
  });

  it('ends a final stop response even when the message contains tool call metadata', async () => {
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
      messages: [],
      sessionLabels: {},
      sessionLastActivity: {},
      sending: true,
      activeRunId: 'run-final-stop',
      streamingText: '',
      streamingMessage: null,
      streamingTools: [{ id: 'tool-1', name: 'exec', status: 'completed', updatedAt: Date.now() }],
      pendingFinal: true,
      lastUserMessageAt: Date.now(),
      pendingToolImages: [],
      error: null,
      loading: false,
      thinkingLevel: null,
    });

    useChatStore.getState().handleChatEvent({
      state: 'final',
      runId: 'run-final-stop',
      sessionKey: 'agent:main:main',
      message: {
        id: 'assistant-final-stop',
        role: 'assistant',
        content: 'Done. <tool_call>{"name":"exec"}</tool_call>',
        stopReason: 'stop',
        tool_calls: [{ id: 'tool-1', type: 'function', function: { name: 'exec', arguments: '{}' } }],
      },
    });

    const state = useChatStore.getState();
    expect(state.sending).toBe(false);
    expect(state.activeRunId).toBeNull();
    expect(state.pendingFinal).toBe(false);
    expect(state.streamingTools).toEqual([]);
    expect(state.messages.at(-1)).toEqual(expect.objectContaining({ id: 'assistant-final-stop' }));
  });

  it('uses one-shot fast reasoning for lightweight input without changing the persisted mode', async () => {
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
      reasoningMode: 'thinking',
    });

    await useChatStore.getState().sendMessage('hello', undefined, null);

    const sendCall = gatewayRpcMock.mock.calls.find(([method]) => method === 'chat.send');
    expect(sendCall?.[1]).toMatchObject({
      sessionKey: 'agent:main:session-1773230400000',
      message: '/think off hello',
      deliver: false,
    });
    expect(gatewayRpcMock.mock.calls.find(([method]) => method === 'sessions.patch')).toBeUndefined();
    const sendIndex = gatewayRpcMock.mock.calls.findIndex(([method]) => method === 'chat.send');
    expect(sendIndex).toBeGreaterThanOrEqual(0);

    useChatStore.setState({ sending: false, activeRunId: null });
    await vi.advanceTimersByTimeAsync(5_000);
    const patchCall = gatewayRpcMock.mock.calls.find(([method]) => method === 'sessions.patch');
    expect(patchCall?.[1]).toEqual({ key: 'agent:main:session-1773230400000', thinkingLevel: 'medium' });
    const patchIndex = gatewayRpcMock.mock.calls.findIndex(([method]) => method === 'sessions.patch');
    expect(patchIndex).toBeGreaterThan(sendIndex);
  });

  it('aggressively downgrades short expert queries but preserves complex expert prompts', async () => {
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
      reasoningMode: 'expert',
    });

    await useChatStore.getState().sendMessage('东莞天气咋样', undefined, null);
    let sendCall = gatewayRpcMock.mock.calls.find(([method]) => method === 'chat.send');
    expect((sendCall?.[1] as Record<string, unknown>).message).toBe('/think off 东莞天气咋样');

    gatewayRpcMock.mockClear();
    await useChatStore.getState().sendMessage('帮我分析这个项目 chat 首包慢的根因并给修复方案', undefined, null);
    sendCall = gatewayRpcMock.mock.calls.find(([method]) => method === 'chat.send');
    expect((sendCall?.[1] as Record<string, unknown>).message).toBe('/think high 帮我分析这个项目 chat 首包慢的根因并给修复方案');
  });

  it('applies reasoning mode through sessions.patch without adding unsupported chat.send params', async () => {
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
      reasoningMode: 'expert',
    });

    await useChatStore.getState().sendMessage('Investigate this', undefined, null);

    const sendCall = gatewayRpcMock.mock.calls.find(([method]) => method === 'chat.send');
    const payload = sendCall?.[1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('thinkingLevel');
    expect(payload.message).toBe('/think high Investigate this');

    expect(gatewayRpcMock.mock.calls.find(([method]) => method === 'sessions.patch')).toBeUndefined();
    expect(useChatStore.getState().thinkingLevel).toBe('high');

    useChatStore.setState({ sending: false, activeRunId: null });
    await vi.advanceTimersByTimeAsync(5_000);
    const patchCall = gatewayRpcMock.mock.calls.find(([method]) => method === 'sessions.patch');
    expect(patchCall?.[1]).toEqual({ key: 'agent:main:session-1773230400000', thinkingLevel: 'high' });
  });

  it('does not pass the current session model to unsupported chat.send params', async () => {
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main', model: 'ly-qwen/qwen3.5-397b' }],
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
      reasoningMode: 'fast',
    });

    await useChatStore.getState().sendMessage('hello', undefined, null);

    const sendCall = gatewayRpcMock.mock.calls.find(([method]) => method === 'chat.send');
    expect(sendCall?.[1]).toMatchObject({
      sessionKey: 'agent:main:session-1773230400000',
    });
    expect(sendCall?.[1]).not.toHaveProperty('model');
  });

  it('keeps text sends unchanged when the session has no model override', async () => {
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
      reasoningMode: 'fast',
    });

    await useChatStore.getState().sendMessage('hello', undefined, null);

    const sendCall = gatewayRpcMock.mock.calls.find(([method]) => method === 'chat.send');
    expect(sendCall?.[1]).not.toHaveProperty('model');
  });

  it('injects convergence strategy for text-only document/data tasks on the real chat store', async () => {
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
      reasoningMode: 'fast',
    });

    await useChatStore.getState().sendMessage('Summarize report.pdf and extract the key table', undefined, null);

    const sendCall = gatewayRpcMock.mock.calls.find(([method]) => method === 'chat.send');
    expect(sendCall?.[1]).toEqual(expect.objectContaining({
      extraSystemPrompt: expect.stringContaining('PDF tasks'),
    }));
    expect(useChatStore.getState().runawayToolObservation).toEqual(expect.objectContaining({
      runId: 'run-text',
      taskKind: 'pdf',
      initialStrategyInjected: true,
    }));
  });

  it('updates real chat store convergence directive from repeated write/exec events', async () => {
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
      reasoningMode: 'fast',
    });

    await useChatStore.getState().sendMessage('Please calculate VMI replenishment from vmi.xlsx', undefined, null);
    const sessionKey = useChatStore.getState().currentSessionKey;

    for (let i = 0; i < 4; i += 1) {
      useChatStore.getState().handleChatEvent({
        state: 'delta',
        runId: 'run-text',
        sessionKey,
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: `write-${i}`, name: 'write', input: { path: `vmi_debug_${i}.py` } }],
        },
      });
      useChatStore.getState().handleChatEvent({
        state: 'delta',
        runId: 'run-text',
        sessionKey,
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: `exec-${i}`, name: 'exec', input: { command: 'uv run python vmi_debug.py' } }],
        },
      });
    }

    expect(useChatStore.getState().runawayToolObservation).toEqual(expect.objectContaining({
      riskState: 'debug_loop',
      convergenceDirectiveLevel: 'medium',
      injectedConvergenceDirectiveLevel: 'medium',
      convergenceDirective: expect.stringContaining('complete processing script'),
    }));
    const directiveCalls = gatewayRpcMock.mock.calls.filter(([method, params]) => (
      method === 'chat.send'
      && typeof params === 'object'
      && params
      && String((params as Record<string, unknown>).message ?? '').startsWith('[LYCLAW internal convergence directive]')
    ));
    expect(directiveCalls).toHaveLength(1);
    expect(directiveCalls[0][1]).toEqual(expect.objectContaining({
      sessionKey,
      deliver: false,
      message: expect.stringContaining('complete processing script'),
    }));
  });

  it('passes convergence strategy through real media send requests', async () => {
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
      reasoningMode: 'fast',
    });

    await useChatStore.getState().sendMessage('Calculate replenishment', [
      {
        fileName: 'vmi.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        fileSize: 128,
        stagedPath: '/tmp/vmi.xlsx',
        preview: null,
      },
    ], null);

    const sendWithMediaCall = hostApiFetchMock.mock.calls.find(([path]) => path === '/api/chat/send-with-media');
    const payload = JSON.parse(
      (sendWithMediaCall?.[1] as { body: string }).body,
    ) as { extraSystemPrompt?: string };

    expect(payload.extraSystemPrompt).toContain('Spreadsheet tasks');
    expect(useChatStore.getState().runawayToolObservation).toEqual(expect.objectContaining({
      runId: 'run-media',
      taskKind: 'spreadsheet',
      initialStrategyInjected: true,
    }));
  });

  it('persists the current session model with sessions.patch', async () => {
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
    });

    await useChatStore.getState().setCurrentSessionModel('ly-deepseek/deepseek-v4-flash');

    expect(useChatStore.getState().sessions.find((session) => session.key === 'agent:main:main')?.model)
      .toBe('ly-deepseek/deepseek-v4-flash');
    const patchCall = gatewayRpcMock.mock.calls.find(([method]) => method === 'sessions.patch');
    expect(patchCall?.[1]).toEqual({
      key: 'agent:main:main',
      model: 'ly-deepseek/deepseek-v4-flash',
    });
  });

  it('keeps the optimistic session model when sessions.patch times out', async () => {
    const { useChatStore } = await import('@/stores/chat');

    gatewayRpcMock.mockImplementation(async (method: string) => {
      if (method === 'sessions.patch') {
        throw new Error('RPC timeout: sessions.patch');
      }
      if (method === 'sessions.list') {
        return { sessions: [] };
      }
      if (method === 'chat.history') {
        return { messages: [] };
      }
      throw new Error(`Unexpected gateway RPC: ${method}`);
    });

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }],
    });

    await expect(useChatStore.getState().setCurrentSessionModel('custom-sub2apig/deepseek-v4-pro'))
      .resolves.toBeUndefined();

    expect(useChatStore.getState().sessions.find((session) => session.key === 'agent:main:main')?.model)
      .toBe('custom-sub2apig/deepseek-v4-pro');
    expect(gatewayRpcMock.mock.calls.some(([method]) => method === 'sessions.list')).toBe(false);
  });
  it('uses the local session model for the next send when sessions.patch fails', async () => {
    const { useChatStore } = await import('@/stores/chat');

    gatewayRpcMock.mockImplementation(async (method: string) => {
      if (method === 'sessions.patch') {
        throw new Error('session not ready');
      }
      if (method === 'chat.send') {
        return { runId: 'run-text' };
      }
      if (method === 'chat.history') {
        return { messages: [] };
      }
      if (method === 'sessions.abort') {
        return { ok: true };
      }
      if (method === 'sessions.list') {
        return { sessions: [] };
      }
      throw new Error(`Unexpected gateway RPC: ${method}`);
    });

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
      reasoningMode: 'fast',
    });

    await expect(useChatStore.getState().setCurrentSessionModel('ly-qwen/qwen3.5-397b')).rejects.toThrow('session not ready');
    await useChatStore.getState().sendMessage('hello', undefined, null);

    const sendCall = gatewayRpcMock.mock.calls.find(([method]) => method === 'chat.send');
    expect(sendCall?.[1]).toMatchObject({
      sessionKey: 'agent:main:session-1773230400000',
    });
    expect(sendCall?.[1]).not.toHaveProperty('model');
  });

  it('does not treat normal @skill text as digital employee execution', async () => {
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

    await useChatStore.getState().sendMessage('@create-skill 帮我整理提示词');

    const sendCall = gatewayRpcMock.mock.calls.find(([method]) => method === 'chat.send');
    expect(sendCall?.[1]).toMatchObject({
      message: '/think off @create-skill 帮我整理提示词',
      deliver: false,
    });
    expect(sendCall?.[1]).not.toHaveProperty('executeAsAgentId');
    expect(sendCall?.[1]).not.toHaveProperty('executedByAgentName');
    expect(useChatStore.getState().currentAgentId).toBe('main');
  });

  it('executes a selected digital employee in the current session for attachment sends', async () => {
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessions: [{ key: 'agent:main:main' }, { key: 'agent:research:desk', model: 'ly-qwen/qwen3.5-397b' }],
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
      reasoningMode: 'fast',
    });

    await useChatStore.getState().sendMessage(
      '',
      [
        {
          fileName: 'design.png',
          mimeType: 'image/png',
          fileSize: 128,
          stagedPath: '/tmp/design.png',
          preview: 'data:image/png;base64,abc',
        },
      ],
      'research',
    );

    expect(useChatStore.getState().currentSessionKey).toBe('agent:main:main');

    expect(hostApiFetchMock).toHaveBeenCalledWith(
      '/api/chat/send-with-media',
      expect.objectContaining({
        method: 'POST',
        body: expect.any(String),
      }),
    );

    const sendWithMediaCall = hostApiFetchMock.mock.calls.find(([path]) => path === '/api/chat/send-with-media');
    const payload = JSON.parse(
      (sendWithMediaCall?.[1] as { body: string }).body,
    ) as {
      sessionKey: string;
      message: string;
      executeAsAgentId?: string;
      executedByAgentName?: string;
      media: Array<{ filePath: string }>;
    };

    expect(payload.sessionKey).toBe('agent:main:main');
    expect(payload.message).toBe('/think off Process the attached file(s).');
    expect(payload).toMatchObject({
      executeAsAgentId: 'research',
      executedByAgentName: 'Research',
    });
    expect(payload).not.toHaveProperty('model');
    expect(payload.media[0]?.filePath).toBe('/tmp/design.png');
  });
});
