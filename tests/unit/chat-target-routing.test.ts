import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
      rpc: gatewayRpcMock,
      status: { gatewayReady: true },
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
      convergenceDirective: expect.stringContaining('complete processing script'),
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
