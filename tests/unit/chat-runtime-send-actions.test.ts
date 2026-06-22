import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeIpc = vi.fn();
const beginChatRunPerf = vi.fn();
const markChatRunRpcStarted = vi.fn();
const markChatRunRpcCompleted = vi.fn();
const beginFirstSessionPerf = vi.fn(() => false);
const markFirstSessionRpcStarted = vi.fn();
const markFirstSessionRpcCompleted = vi.fn();

vi.mock('@/lib/api-client', () => ({
  invokeIpc: (...args: unknown[]) => invokeIpc(...args),
}));

vi.mock('@/stores/agents', () => ({
  useAgentsStore: {
    getState: () => ({ agents: [] }),
  },
}));

vi.mock('@/stores/settings', () => ({
  useSettingsStore: {
    getState: () => ({
      contextCompressionEnabled: false,
      contextCompressionThreshold: 9999,
    }),
  },
}));

vi.mock('@/stores/chat/context-compactor', () => ({
  compressHistory: vi.fn(),
  resetCompactorSession: vi.fn(),
}));

vi.mock('@/stores/chat/chat-run-perf', () => ({
  beginChatRunPerf: (...args: unknown[]) => beginChatRunPerf(...args),
  markChatRunRpcStarted: (...args: unknown[]) => markChatRunRpcStarted(...args),
  markChatRunRpcCompleted: (...args: unknown[]) => markChatRunRpcCompleted(...args),
}));

vi.mock('@/stores/chat/first-session-perf', () => ({
  beginFirstSessionPerf: (...args: unknown[]) => beginFirstSessionPerf(...args),
  markFirstSessionRpcStarted: (...args: unknown[]) => markFirstSessionRpcStarted(...args),
  markFirstSessionRpcCompleted: (...args: unknown[]) => markFirstSessionRpcCompleted(...args),
}));

describe('createRuntimeSendActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invokeIpc.mockResolvedValue({
      success: false,
      error: 'Error: Network access denied: 10.0.1.83',
    });
  });

  function makeHarness() {
    const state: Record<string, unknown> = {
      currentSessionKey: 'agent:main:session-test',
      currentAgentId: 'main',
      reasoningMode: 'fast',
      messages: [],
      sessions: [{ key: 'agent:main:session-test', displayName: 'test' }],
      sessionLabels: {},
      sessionLastActivity: {},
      sessionStreamingStates: {},
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      activeRunId: null,
      error: null,
      runError: null,
      pendingFinal: false,
      pendingToolImages: [],
      sending: false,
      lastUserMessageAt: null,
      runawayToolObservation: null,
      sessionRunawayToolObservations: {},
      loadHistory: vi.fn(),
    };
    const set = vi.fn((partial: unknown) => {
      const patch = typeof partial === 'function' ? partial(state) : partial;
      Object.assign(state, patch);
    });
    const get = vi.fn(() => state);
    return { state, set, get };
  }

  it('把用户拒绝安全确认当作取消，而不是底部红色错误', async () => {
    const { createRuntimeSendActions } = await import('@/stores/chat/runtime-send-actions');
    const h = makeHarness();
    const actions = createRuntimeSendActions(h.set as never, h.get as never);

    await actions.sendMessage('访问 http://10.0.1.83:8009/api/check-token');

    expect(invokeIpc).toHaveBeenCalledWith(
      'gateway:rpc',
      'chat.send',
      expect.objectContaining({ sessionKey: 'agent:main:session-test' }),
      expect.any(Number),
    );
    expect(h.state.error).toBeNull();
    expect(h.state.runError).toBeNull();
    expect(h.state.sending).toBe(false);
    expect(h.state.activeRunId).toBeNull();
    expect(h.state.streamingMessage).toBeNull();
    expect(h.state.streamingTools).toEqual([]);
    // 拒绝后应给出会话内的温和取消提示，而不是空无响应
    expect(h.state.securityCancelNotice).toBeTruthy();
  });

  it('拒绝读取 workspace 外文件后给出温和取消提示而非红色错误', async () => {
    invokeIpc.mockResolvedValue({
      success: false,
      error: 'Error: Local file path access denied by user: D:\\测试2\\hello.txt',
    });
    const { createRuntimeSendActions } = await import('@/stores/chat/runtime-send-actions');
    const h = makeHarness();
    const actions = createRuntimeSendActions(h.set as never, h.get as never);

    await actions.sendMessage('读取 D:\\测试2\\hello.txt 文件');

    expect(h.state.error).toBeNull();
    expect(h.state.runError).toBeNull();
    expect(h.state.sending).toBe(false);
    expect(h.state.activeRunId).toBeNull();
    expect(h.state.securityCancelNotice).toBeTruthy();
  });
  it('initializes and binds runaway tool observation for document/data tasks', async () => {
    invokeIpc.mockResolvedValue({
      success: true,
      result: { runId: 'run-observed' },
    });
    const { createRuntimeSendActions } = await import('@/stores/chat/runtime-send-actions');
    const h = makeHarness();
    const actions = createRuntimeSendActions(h.set as never, h.get as never);

    await actions.sendMessage('Please calculate VMI replenishment from the spreadsheet', [
      {
        fileName: 'vmi.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        fileSize: 1024,
        stagedPath: 'C:\\tmp\\vmi.xlsx',
        preview: null,
      },
    ]);

    expect(invokeIpc).toHaveBeenCalledWith(
      'chat:sendWithMedia',
      expect.objectContaining({
        extraSystemPrompt: expect.stringContaining('Spreadsheet tasks'),
      }),
    );
    expect(h.state.runawayToolObservation).toEqual(expect.objectContaining({
      runId: 'run-observed',
      sessionKey: 'agent:main:session-test',
      taskKind: 'spreadsheet',
      toolCallCount: 0,
      initialStrategyInjected: true,
    }));
    expect((h.state.sessionRunawayToolObservations as Record<string, unknown>)['agent:main:session-test']).toEqual(
      expect.objectContaining({ runId: 'run-observed', taskKind: 'spreadsheet' }),
    );
  });

  it('injects convergence strategy for text-only document tasks', async () => {
    invokeIpc.mockResolvedValue({
      success: true,
      result: { runId: 'run-pdf' },
    });
    const { createRuntimeSendActions } = await import('@/stores/chat/runtime-send-actions');
    const h = makeHarness();
    const actions = createRuntimeSendActions(h.set as never, h.get as never);

    await actions.sendMessage('Summarize report.pdf and extract the key table');

    expect(invokeIpc).toHaveBeenCalledWith(
      'gateway:rpc',
      'chat.send',
      expect.objectContaining({
        extraSystemPrompt: expect.stringContaining('PDF tasks'),
      }),
      expect.any(Number),
    );
    expect(h.state.runawayToolObservation).toEqual(expect.objectContaining({
      runId: 'run-pdf',
      taskKind: 'pdf',
      initialStrategyInjected: true,
    }));
  });
});
