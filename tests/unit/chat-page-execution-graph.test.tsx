import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const hostApiFetchMock = vi.fn();

const { gatewayState, agentsState, chatScrollRef } = vi.hoisted(() => ({
  gatewayState: {
    status: { state: 'running', port: 18789, warmupStatus: 'ready' } as Record<string, unknown>,
  },
  agentsState: {
    agents: [{ id: 'main', name: 'main' }] as Array<Record<string, unknown>>,
    fetchAgents: vi.fn(),
  },
  chatScrollRef: {
    current: null as HTMLElement | null,
  },
}));

vi.mock('@/stores/gateway', () => {
  const useGatewayStore = Object.assign(
    (selector: (state: typeof gatewayState) => unknown) => selector(gatewayState),
    {
      getState: () => gatewayState,
      subscribe: vi.fn(() => vi.fn()),
    },
  );
  return { useGatewayStore };
});

vi.mock('@/stores/agents', () => ({
  useAgentsStore: (selector: (state: typeof agentsState) => unknown) => selector(agentsState),
}));

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
}));

vi.mock('@/lib/ui-state-persistence', () => ({
  flushUiStateSync: vi.fn(),
  hydrateUiStateFromDisk: vi.fn(),
  startUiStateSync: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  initReactI18next: {
    type: '3rdParty',
    init: () => {},
  },
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (key === 'executionGraph.collapsedSummary') {
        return `collapsed ${String(params?.toolCount ?? '')} ${String(params?.processCount ?? '')}`.trim();
      }
      if (key === 'executionGraph.agentRun') {
        return `Main execution`;
      }
      if (key === 'executionGraph.title') {
        return 'Execution Graph';
      }
      if (key === 'executionGraph.collapseAction') {
        return 'Collapse';
      }
      if (key === 'executionGraph.thinkingLabel') {
        return 'Thinking';
      }
      if (key.startsWith('taskPanel.stepStatus.')) {
        return key.split('.').at(-1) ?? key;
      }
      return key;
    },
  }),
}));

vi.mock('@/hooks/use-stick-to-bottom-instant', () => ({
  useStickToBottomInstant: () => ({
    contentRef: { current: null },
    scrollRef: chatScrollRef,
  }),
}));

vi.mock('@/hooks/use-min-loading', () => ({
  useMinLoading: () => false,
}));

vi.mock('@/pages/Chat/ChatToolbar', () => ({
  ChatToolbar: () => null,
}));

vi.mock('@/pages/Chat/ChatInput', () => ({
  ChatInput: () => null,
}));

vi.mock('@/pages/Chat/ChatMessage', () => ({
  ChatMessage: ({ message, textOverride }: { message: { content?: unknown }; textOverride?: string }) => {
    const text = typeof textOverride === 'string'
      ? textOverride
      : typeof message?.content === 'string'
        ? message.content
        : Array.isArray(message?.content)
          ? message.content
            .filter((block): block is { type?: string; text?: string } => typeof block === 'object' && block !== null)
            .filter((block) => block.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text)
            .join(' ')
          : '';
    return <div>{text}</div>;
  },
}));

describe('Chat execution graph lifecycle', () => {
  beforeEach(async () => {
    vi.resetModules();
    hostApiFetchMock.mockReset();
    hostApiFetchMock.mockResolvedValue({ success: true, messages: [] });
    agentsState.fetchAgents.mockReset();
    gatewayState.status = { state: 'running', port: 18789, warmupStatus: 'ready' };
    chatScrollRef.current = null;

    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState({
      messages: [
        {
          role: 'user',
          content: 'Check semiconductor chatter',
        },
        {
          role: 'assistant',
          id: 'tool-turn',
          content: [
            { type: 'text', text: 'Checked X.' },
            { type: 'tool_use', id: 'browser-search', name: 'browser', input: { action: 'search', query: 'semiconductor' } },
          ],
        },
      ],
      loading: false,
      error: null,
      runError: null,
      sending: true,
      activeRunId: 'run-live',
      streamingText: '',
      streamingMessage: {
        role: 'assistant',
        id: 'final-stream',
        content: [
          { type: 'text', text: 'Checked X.' },
          { type: 'text', text: 'Checked X. Here is the summary.' },
        ],
      },
      streamingTools: [
        {
          toolCallId: 'browser-search',
          name: 'browser',
          status: 'completed',
          updatedAt: Date.now(),
        },
      ],
      pendingFinal: true,
      lastUserMessageAt: Date.now(),
      pendingToolImages: [],
      sessions: [{ key: 'agent:main:main' }],
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessionLabels: {},
      sessionLastActivity: {},
      thinkingLevel: null,
    });
  });

  it('keeps the execution graph expanded while the reply is still streaming and shows only the reply suffix in the bubble', async () => {
    const { Chat } = await import('@/pages/Chat/index');

    render(<Chat />);

    await waitFor(() => {
      expect(screen.getByTestId('chat-execution-graph')).toHaveAttribute('data-collapsed', 'false');
    });

    expect(screen.getByText('Here is the summary.')).toBeInTheDocument();
    expect(screen.queryByText('Checked X. Here is the summary.')).not.toBeInTheDocument();
  });

  it('renders no-tool assistant deltas as a progressively updating chat bubble', async () => {
    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState({
      messages: [
        {
          role: 'user',
          content: 'Introduce Dongguan',
        },
      ],
      loading: false,
      error: null,
      runError: null,
      sending: true,
      activeRunId: 'run-text-stream',
      streamingText: '',
      streamingMessage: {
        role: 'assistant',
        id: 'text-stream',
        content: [{ type: 'text', text: 'Dongguan is' }],
      },
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: Date.now(),
      pendingToolImages: [],
      sessions: [{ key: 'agent:main:main' }],
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessionLabels: {},
      sessionLastActivity: {},
      thinkingLevel: null,
    });

    const { Chat } = await import('@/pages/Chat/index');
    render(<Chat />);

    await waitFor(() => {
      expect(screen.getByText('Dongguan is')).toBeInTheDocument();
    });

    useChatStore.setState({
      streamingMessage: {
        role: 'assistant',
        id: 'text-stream',
        content: [{ type: 'text', text: 'Dongguan is a manufacturing center.' }],
      },
    });

    await waitFor(() => {
      expect(screen.getByText('Dongguan is a manufacturing center.')).toBeInTheDocument();
    });
    expect(screen.queryByText('Dongguan is')).not.toBeInTheDocument();
  });

  it('keeps streaming the next assistant turn while the previous tool status is still running', async () => {
    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState({
      messages: [
        {
          role: 'user',
          content: 'Build a presentation',
        },
        {
          role: 'assistant',
          id: 'tool-turn',
          content: [
            { type: 'text', text: 'Generating the slides.' },
            { type: 'tool_use', id: 'ppt-export', name: 'exec', input: { command: 'export-ppt' } },
          ],
        },
      ],
      loading: false,
      error: null,
      runError: null,
      sending: true,
      activeRunId: 'run-tool-followup-stream',
      streamingText: '',
      streamingMessage: {
        role: 'assistant',
        id: 'followup-stream',
        content: [{ type: 'text', text: 'The presentation has' }],
      },
      streamingTools: [
        {
          toolCallId: 'ppt-export',
          name: 'exec',
          status: 'running',
          updatedAt: Date.now(),
        },
      ],
      pendingFinal: true,
      lastUserMessageAt: Date.now(),
      pendingToolImages: [],
      sessions: [{ key: 'agent:main:main' }],
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessionLabels: {},
      sessionLastActivity: {},
      thinkingLevel: null,
    });

    const { Chat } = await import('@/pages/Chat/index');
    render(<Chat />);

    await waitFor(() => {
      expect(screen.getByText('The presentation has')).toBeInTheDocument();
    });

    useChatStore.setState({
      streamingMessage: {
        role: 'assistant',
        id: 'followup-stream',
        content: [{ type: 'text', text: 'The presentation has been exported.' }],
      },
    });

    await waitFor(() => {
      expect(screen.getByText('The presentation has been exported.')).toBeInTheDocument();
    });
  });

  it('keeps the viewport pinned to new streamingMessage deltas', async () => {
    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState({
      messages: [
        {
          role: 'user',
          content: 'Introduce Dongguan',
        },
      ],
      loading: false,
      error: null,
      runError: null,
      sending: true,
      activeRunId: 'run-scroll-stream',
      streamingText: '',
      streamingMessage: {
        role: 'assistant',
        id: 'scroll-stream',
        content: [{ type: 'text', text: 'Dongguan is' }],
      },
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: Date.now(),
      pendingToolImages: [],
      sessions: [{ key: 'agent:main:main' }],
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessionLabels: {},
      sessionLastActivity: {},
      thinkingLevel: null,
    });

    const { Chat } = await import('@/pages/Chat/index');
    render(<Chat />);

    await waitFor(() => {
      expect(chatScrollRef.current).not.toBeNull();
    });

    const scrollElement = chatScrollRef.current!;
    Object.defineProperty(scrollElement, 'scrollHeight', {
      configurable: true,
      value: 1200,
    });
    scrollElement.scrollTop = 0;
    useChatStore.setState({
      streamingMessage: {
        role: 'assistant',
        id: 'scroll-stream',
        content: [{ type: 'text', text: 'Dongguan is a manufacturing center.' }],
      },
    });

    await waitFor(() => {
      expect(scrollElement.scrollTop).toBe(1200);
    });
  });

  it('renders the execution graph immediately for an active run before any stream content arrives', async () => {
    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState({
      messages: [
        {
          role: 'user',
          content: 'Check semiconductor chatter',
        },
      ],
      loading: false,
      error: null,
      runError: null,
      sending: true,
      activeRunId: 'run-starting',
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: Date.now(),
      pendingToolImages: [],
      sessions: [{ key: 'agent:main:main' }],
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessionLabels: {},
      sessionLastActivity: {},
      thinkingLevel: null,
    });

    const { Chat } = await import('@/pages/Chat/index');

    render(<Chat />);

    await waitFor(() => {
      expect(screen.getByTestId('chat-execution-graph')).toHaveAttribute('data-collapsed', 'false');
    });

    expect(screen.getByTestId('chat-execution-step-thinking-trailing')).toBeInTheDocument();
    expect(screen.getAllByText('Thinking').length).toBeGreaterThan(0);
  });

  it('renders a running thinking step for an empty streaming thinking block', async () => {
    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState({
      messages: [
        {
          role: 'user',
          content: 'Start thinking',
        },
      ],
      loading: false,
      error: null,
      runError: null,
      sending: true,
      activeRunId: 'run-thinking',
      streamingText: '',
      streamingMessage: {
        role: 'assistant',
        id: 'thinking-stream',
        content: [{ type: 'thinking' }],
      },
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: Date.now(),
      pendingToolImages: [],
      sessions: [{ key: 'agent:main:main' }],
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessionLabels: {},
      sessionLastActivity: {},
      thinkingLevel: null,
    });

    const { Chat } = await import('@/pages/Chat/index');

    render(<Chat />);

    await waitFor(() => {
      expect(screen.getByTestId('chat-execution-graph')).toHaveAttribute('data-collapsed', 'false');
    });
    expect(screen.getAllByText('Thinking').length).toBeGreaterThan(0);
  });

  it('shows the centered first-response progress card while the gateway is warming', async () => {
    gatewayState.status = {
      state: 'running',
      port: 18789,
      warmupStatus: 'warming',
    };

    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState({
      messages: [
        {
          role: 'user',
          content: 'Start the first run',
        },
      ],
      loading: false,
      error: null,
      runError: null,
      sending: true,
      activeRunId: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: Date.now(),
      pendingToolImages: [],
      sessions: [{ key: 'agent:main:main' }],
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessionLabels: {},
      sessionLastActivity: {},
      thinkingLevel: null,
    });

    const { Chat } = await import('@/pages/Chat/index');

    render(<Chat />);

    await waitFor(() => {
      expect(screen.getByTestId('first-response-progress-card')).toBeInTheDocument();
    });
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '55');
  });

  it('renders generated file cards with line stats for edit tools', async () => {
    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState({
      messages: [
        {
          role: 'user',
          content: 'Patch the workspace file',
        },
        {
          role: 'assistant',
          id: 'edit-turn',
          content: [
            {
              type: 'tool_use',
              id: 'edit-1',
              name: 'Edit',
              input: {
                file_path: '/workspace/demo.ts',
                old_string: 'const value = 1\n',
                new_string: 'const value = 2\n',
              },
            },
          ],
        },
        {
          role: 'assistant',
          id: 'reply-turn',
          content: [{ type: 'text', text: 'Updated the file.' }],
        },
      ],
      loading: false,
      error: null,
      runError: null,
      sending: false,
      activeRunId: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: Date.now(),
      pendingToolImages: [],
      sessions: [{ key: 'agent:main:main' }],
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessionLabels: {},
      sessionLastActivity: {},
      thinkingLevel: null,
    });

    const { Chat } = await import('@/pages/Chat/index');

    render(<Chat />);

    fireEvent.click(screen.getByTestId('chat-execution-graph'));

    await waitFor(() => {
      expect(screen.getByText((content) => content.includes('/workspace/demo.ts'))).toBeInTheDocument();
    });

    expect(screen.getByText((content) => content.includes('const value = 2'))).toBeInTheDocument();
    expect(screen.getByText((content) => content.includes('const value = 1'))).toBeInTheDocument();
  });

  it('stops showing trailing thinking and renders run error callout after terminal model error', async () => {
    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState({
      messages: [
        {
          role: 'user',
          content: 'Check semiconductor chatter',
        },
        {
          role: 'assistant',
          id: 'tool-turn',
          content: [
            { type: 'text', text: 'Checked X.' },
            { type: 'tool_use', id: 'browser-search', name: 'browser', input: { action: 'search', query: 'semiconductor' } },
          ],
        },
      ],
      loading: false,
      error: null,
      runError: '404 Resource not found',
      sending: false,
      activeRunId: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      sessions: [{ key: 'agent:main:main' }],
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessionLabels: {},
      sessionLastActivity: {},
      thinkingLevel: null,
    });

    const { Chat } = await import('@/pages/Chat/index');

    render(<Chat />);

    await waitFor(() => {
      expect(screen.getByTestId('chat-execution-graph')).toBeInTheDocument();
    });

    expect(screen.queryByTestId('chat-execution-step-thinking-trailing')).not.toBeInTheDocument();
    expect(screen.getAllByText('404 Resource not found').length).toBeGreaterThan(0);
  });

  it('stops stale trailing thinking after a subagent completion event returns without live stream activity', async () => {
    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState({
      messages: [
        {
          role: 'user',
          content: 'Check tomorrow weather',
        },
        {
          role: 'assistant',
          id: 'spawn-turn',
          content: [
            {
              type: 'tool_use',
              id: 'spawn-call',
              name: 'sessions_spawn',
              input: { agentId: 'subagent', task: 'Check tomorrow weather' },
            },
          ],
        },
        {
          role: 'assistant',
          id: 'yield-turn',
          content: [
            {
              type: 'tool_use',
              id: 'yield-call',
              name: 'sessions_yield',
              input: { message: 'Waiting for weather subtask.' },
            },
          ],
        },
        {
          role: 'user',
          id: 'subagent-complete',
          content: `[Internal task completion event]
source: subagent
session_key: agent:subagent:child-123
session_id: child-session-id
type: subagent task
status: completed successfully`,
        },
      ],
      loading: false,
      error: null,
      runError: null,
      sending: true,
      activeRunId: 'stale-parent-run',
      streamingText: '',
      streamingMessage: null,
      streamingTools: [
        {
          toolCallId: 'yield-call',
          name: 'sessions_yield',
          status: 'completed',
          updatedAt: Date.now(),
        },
      ],
      pendingFinal: true,
      lastUserMessageAt: Date.now(),
      pendingToolImages: [],
      sessions: [{ key: 'agent:main:main' }],
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessionLabels: {},
      sessionLastActivity: {},
      thinkingLevel: null,
    });

    const { Chat } = await import('@/pages/Chat/index');

    render(<Chat />);

    expect(screen.queryByTestId('chat-execution-step-thinking-trailing')).not.toBeInTheDocument();
  });

  it('shows an execution graph while waiting for a spawned subagent', async () => {
    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState({
      messages: [
        {
          role: 'user',
          content: 'Check tomorrow weather',
        },
        {
          role: 'assistant',
          id: 'spawn-turn',
          content: [
            {
              type: 'tool_use',
              id: 'spawn-call',
              name: 'sessions_spawn',
              input: { agentId: 'subagent', task: 'Check tomorrow weather' },
            },
          ],
        },
      ],
      loading: false,
      error: null,
      runError: null,
      sending: true,
      activeRunId: 'parent-run',
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: true,
      lastUserMessageAt: Date.now(),
      pendingToolImages: [],
      sessions: [{ key: 'agent:main:main' }],
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessionLabels: {},
      sessionLastActivity: {},
      thinkingLevel: null,
    });

    const { Chat } = await import('@/pages/Chat/index');

    render(<Chat />);

    expect(screen.getByTestId('chat-execution-graph')).toBeInTheDocument();
    expect(screen.queryByText('sessions_spawn')).not.toBeInTheDocument();
    expect(screen.getByText(/coder run|Spawned branch/i)).toBeInTheDocument();
  });

  it('does not keep the execution graph active from stale tool history after the run has stopped', async () => {
    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState({
      messages: [
        {
          role: 'user',
          content: 'Run a script',
        },
        {
          role: 'assistant',
          id: 'tool-turn',
          content: [
            {
              type: 'tool_use',
              id: 'exec-call',
              name: 'exec',
              input: { command: 'python slow.py' },
            },
          ],
        },
      ],
      loading: false,
      error: null,
      runError: null,
      sending: false,
      activeRunId: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      sessions: [{ key: 'agent:main:main' }],
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessionLabels: {},
      sessionLastActivity: {},
      thinkingLevel: null,
    });

    const { Chat } = await import('@/pages/Chat/index');

    render(<Chat />);

    expect(screen.queryByTestId('chat-execution-step-thinking-trailing')).not.toBeInTheDocument();
    const graph = screen.queryByTestId('chat-execution-graph');
    if (graph) {
      expect(graph).toHaveAttribute('data-collapsed', 'true');
    }
  });

  it('hides trailing thinking after a committed typhoon final reply even if tool history remains', async () => {
    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState({
      messages: [
        { role: 'user', content: '帮我查下台风实时路径' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '这些台风网页面是动态渲染的，直接抓取不到实时数据。让我换个方式帮你查。' },
            { type: 'toolCall', id: 'browser-1', name: 'browser', arguments: { action: 'navigate' } },
          ],
          stopReason: 'toolUse',
        },
        {
          role: 'assistant',
          content: [
            '以下是来自浙江省水利厅台风实时路径系统的数据：',
            '',
            '---',
            '',
            '## 🌪️ 2026年第09号台风 **巴威 (BAVI)**',
            '',
            '需要我持续关注这个台风的后续动态吗？',
          ].join('\n'),
          stopReason: 'stop',
        },
      ],
      loading: false,
      error: null,
      runError: null,
      sending: false,
      activeRunId: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      sessions: [{ key: 'agent:main:main' }],
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessionLabels: {},
      sessionLastActivity: {},
      thinkingLevel: null,
      sessionBackendActivity: null,
      gatewayBackgroundActivity: null,
    });

    const { Chat } = await import('@/pages/Chat/index');
    render(<Chat />);

    expect(screen.getByText(/巴威 \(BAVI\)/)).toBeInTheDocument();
    expect(screen.queryByTestId('chat-execution-step-thinking-trailing')).not.toBeInTheDocument();
  });

  it('shows a stopReason stop typhoon report as a bubble after abort, not in graph message steps', async () => {
    const typhoonReport = [
      '这些台风网页面是动态渲染的，直接抓取不到实时数据。让我换个方式帮你查。',
      '这些页面都是动态渲染的，让我用浏览器打开台风实时路径图。',
      '以下是来自浙江省水利厅台风实时路径系统的数据：',
      '',
      '---',
      '',
      '## 🌪️ 2026年第09号台风 **巴威 (BAVI)**',
      '',
      '| 项目 | 详情 |',
      '|------|------|',
      '| **更新时间** | 2026年7月9日 11:00 |',
      '',
      '需要我持续关注这个台风的后续动态吗？',
    ].join('\n');

    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState({
      messages: [
        { role: 'user', content: '帮我查下台风实时路径' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '这些台风网页面是动态渲染的，直接抓取不到实时数据。让我换个方式帮你查。' },
            { type: 'toolCall', id: 'browser-1', name: 'browser', arguments: { action: 'navigate' } },
          ],
          stopReason: 'toolUse',
        },
        {
          role: 'assistant',
          content: typhoonReport,
          stopReason: 'stop',
        },
      ],
      loading: false,
      error: null,
      runError: null,
      sending: false,
      activeRunId: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      runAborted: true,
      lastUserMessageAt: null,
      pendingToolImages: [],
      sessions: [{ key: 'agent:main:main' }],
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessionLabels: {},
      sessionLastActivity: {},
      thinkingLevel: null,
      sessionBackendActivity: null,
      gatewayBackgroundActivity: null,
    });

    const { Chat } = await import('@/pages/Chat/index');
    render(<Chat />);

    const bubble = screen.getByTestId('chat-message-2');
    expect(bubble).toHaveTextContent('以下是来自浙江省水利厅');
    expect(bubble).toHaveTextContent('巴威 (BAVI)');

    const graph = screen.getByTestId('chat-execution-graph');
    fireEvent.click(graph);
    const stepTexts = screen.getAllByTestId('chat-execution-step').map((node) => node.textContent ?? '');
    expect(stepTexts.some((text) => text.includes('让我换个方式帮你查'))).toBe(true);
    expect(stepTexts.some((text) => text.includes('巴威 (BAVI)') || text.includes('需要我持续关注'))).toBe(false);
    expect(screen.queryByTestId('chat-execution-step-thinking-trailing')).not.toBeInTheDocument();
  });
  it('keeps an all-subagents-returned final as a bubble and settles stale execution state', async () => {
    const finalReply = 'Both sub-agents have returned. Here is the summary analysis.\n\n## Typhoon path + Dongguan weather';
    const processNarration = 'Both sub-agents started; waiting for their results.';

    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState({
      messages: [
        { role: 'user', content: 'check typhoon and dongguan weather with two sub agents', timestamp: 1000 },
        {
          role: 'assistant',
          id: 'spawn-two-children',
          content: [
            { type: 'toolCall', id: 'spawn-1', name: 'sessions_spawn', input: { taskName: 'typhoon_tracker' } },
            { type: 'toolCall', id: 'spawn-2', name: 'sessions_spawn', input: { taskName: 'dongguan_weather' } },
          ],
          stopReason: 'toolUse',
        },
        { role: 'toolResult', toolCallId: 'spawn-1', content: [{ type: 'text', text: JSON.stringify({ status: 'accepted', childSessionKey: 'agent:main:subagent:typhoon' }) }] },
        { role: 'toolResult', toolCallId: 'spawn-2', content: [{ type: 'text', text: JSON.stringify({ status: 'accepted', childSessionKey: 'agent:main:subagent:weather' }) }] },
        {
          role: 'assistant',
          id: 'yield-two-children',
          content: [
            { type: 'text', text: processNarration },
            { type: 'toolCall', id: 'yield-1', name: 'sessions_yield', arguments: { message: 'waiting' } },
          ],
          stopReason: 'toolUse',
        },
        { role: 'toolResult', toolCallId: 'yield-1', content: [{ type: 'text', text: JSON.stringify({ status: 'yielded' }) }] },
        { role: 'assistant', content: '[Internal task completion event]\nsession_key: agent:main:subagent:typhoon\nsession_id: child-1' },
        { role: 'assistant', content: '[Internal task completion event]\nsession_key: agent:main:subagent:weather\nsession_id: child-2' },
        {
          role: 'assistant',
          id: 'all-subagents-summary-final',
          content: finalReply,
          stopReason: 'stop',
          timestamp: 5000,
        },
      ],
      loading: false,
      error: null,
      runError: null,
      sending: true,
      activeRunId: 'stale-announce-run',
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: true,
      runAborted: false,
      lastUserMessageAt: 1000,
      pendingToolImages: [],
      sessions: [{ key: 'agent:main:main' }],
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessionLabels: {},
      sessionLastActivity: {},
      thinkingLevel: null,
      sessionBackendActivity: null,
      gatewayBackgroundActivity: { processingSessionKeys: ['agent:main:session-parent'] },
    });

    const { Chat } = await import('@/pages/Chat/index');
    render(<Chat />);

    const bubble = screen.getByTestId('chat-message-8');
    expect(bubble).toHaveTextContent('Both sub-agents have returned');
    expect(screen.queryByTestId('chat-execution-step-thinking-trailing')).not.toBeInTheDocument();

    const graph = screen.getByTestId('chat-execution-graph');
    expect(graph).toHaveAttribute('data-collapsed', 'true');
    fireEvent.click(graph);
    const stepTexts = screen.getAllByTestId('chat-execution-step').map((node) => node.textContent ?? '');
    expect(stepTexts.some((text) => text.includes(processNarration))).toBe(true);
    expect(stepTexts.some((text) => text.includes('Both sub-agents have returned'))).toBe(false);
  });

  it('keeps a renderer synthetic final as a bubble when stale streaming state is still present', async () => {
    const finalReply = 'Most typhoon sites are blocked, but here is the latest useful summary.';
    const processNarration = 'I will try several weather sources.';

    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState({
      messages: [
        { role: 'user', content: 'latest typhoon status' },
        {
          role: 'assistant',
          id: 'tool-round-synthetic-final',
          content: [
            { type: 'text', text: processNarration },
            { type: 'toolCall', id: 'search-1', name: 'web_search', arguments: { query: 'typhoon' } },
          ],
          stopReason: 'toolUse',
        },
        { role: 'toolResult', toolCallId: 'search-1', toolName: 'web_search', content: 'blocked' },
        {
          role: 'assistant',
          id: 'run-123e4567-e89b-12d3-a456-426614174000',
          content: finalReply,
        },
      ],
      loading: false,
      error: null,
      runError: null,
      sending: true,
      activeRunId: '123e4567-e89b-12d3-a456-426614174000',
      streamingText: finalReply,
      streamingMessage: {
        role: 'assistant',
        id: 'stale-synthetic-stream',
        content: finalReply,
      },
      streamingTools: [
        {
          toolCallId: 'search-1',
          name: 'web_search',
          status: 'completed',
          updatedAt: Date.now(),
        },
      ],
      pendingFinal: true,
      runAborted: false,
      lastUserMessageAt: Date.now() - 10_000,
      pendingToolImages: [],
      sessions: [{ key: 'agent:main:main' }],
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessionLabels: {},
      sessionLastActivity: {},
      thinkingLevel: null,
      sessionBackendActivity: null,
      gatewayBackgroundActivity: null,
    });

    const { Chat } = await import('@/pages/Chat/index');
    render(<Chat />);

    const bubble = screen.getByTestId('chat-message-3');
    expect(bubble).toHaveTextContent(finalReply);
    expect(screen.queryByTestId('chat-execution-step-thinking-trailing')).not.toBeInTheDocument();

    const graph = screen.getByTestId('chat-execution-graph');
    fireEvent.click(graph);
    const stepTexts = screen.getAllByTestId('chat-execution-step').map((node) => node.textContent ?? '');
    expect(stepTexts.some((text) => text.includes(processNarration))).toBe(true);
    expect(stepTexts.some((text) => text.includes(finalReply))).toBe(false);
  });

  it('keeps a committed stop final as a bubble when stale streaming state is still present', async () => {
    const finalReply = 'Final BAVI report for the user.';
    const processNarration = 'I found advisory data and will fetch details.';

    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState({
      messages: [
        { role: 'user', content: 'check current typhoon status' },
        {
          role: 'assistant',
          id: 'tool-round',
          content: [
            { type: 'text', text: processNarration },
            { type: 'toolCall', id: 'fetch-1', name: 'web_fetch', arguments: { url: 'https://example.test/advisory' } },
          ],
          stopReason: 'toolUse',
        },
        {
          role: 'toolResult',
          toolCallId: 'fetch-1',
          toolName: 'web_fetch',
          content: 'advisory data',
        },
        {
          role: 'assistant',
          id: 'committed-final',
          content: [
            { type: 'thinking', thinking: 'Now I have a good picture. Let me summarize.' },
            { type: 'text', text: finalReply },
          ],
          stopReason: 'stop',
        },
      ],
      loading: false,
      error: null,
      runError: null,
      sending: true,
      activeRunId: 'run-stale',
      streamingText: 'stale stream text that should not hide the committed final',
      streamingMessage: {
        role: 'assistant',
        id: 'stale-stream',
        content: 'stale stream text that should not hide the committed final',
      },
      streamingTools: [
        {
          toolCallId: 'fetch-1',
          name: 'web_fetch',
          status: 'completed',
          updatedAt: Date.now(),
        },
      ],
      pendingFinal: true,
      runAborted: false,
      lastUserMessageAt: Date.now() - 10_000,
      pendingToolImages: [],
      sessions: [{ key: 'agent:main:main' }],
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessionLabels: {},
      sessionLastActivity: {},
      thinkingLevel: null,
      sessionBackendActivity: null,
      gatewayBackgroundActivity: null,
    });

    const { Chat } = await import('@/pages/Chat/index');
    render(<Chat />);

    const bubble = screen.getByTestId('chat-message-3');
    expect(bubble).toHaveTextContent(finalReply);
    expect(screen.queryByTestId('chat-execution-step-thinking-trailing')).not.toBeInTheDocument();

    const graph = screen.getByTestId('chat-execution-graph');
    fireEvent.click(graph);
    const stepTexts = screen.getAllByTestId('chat-execution-step').map((node) => node.textContent ?? '');
    expect(stepTexts.some((text) => text.includes(processNarration))).toBe(true);
    expect(stepTexts.some((text) => text.includes(finalReply))).toBe(false);
  });

  it('removes cached thinking that belongs to the committed final reply', async () => {
    const { filterCommittedReplyDuplicateSteps } = await import('@/pages/Chat/index');

    const cleaned = filterCommittedReplyDuplicateSteps(
      [
        {
          id: 'stream-thinking-0',
          label: 'Thinking',
          status: 'completed',
          kind: 'thinking',
          detail: 'The user wants the full document content, not a summary.',
        },
        {
          id: 'history-message-0',
          label: 'Message',
          status: 'completed',
          kind: 'message',
          detail: 'Earlier tool narration.',
        },
      ],
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'The user wants the full document content, not a summary.' },
          { type: 'text', text: '# Full document content' },
        ],
        stopReason: 'stop',
      },
    );

    expect(cleaned).toEqual([
      expect.objectContaining({
        id: 'history-message-0',
        detail: 'Earlier tool narration.',
      }),
    ]);
  });

  it('strips thinking-classified process text from a committed final reply bubble', async () => {
    const processNarration = 'I checked the source messages and grouped the important items.';
    const finalReply = 'Here are the important items.';

    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState({
      messages: [
        { role: 'user', content: 'summarize messages' },
        {
          role: 'assistant',
          id: 'thinking-process',
          content: [
            { type: 'thinking', thinking: processNarration },
            { type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'messages.json' } },
          ],
          stopReason: 'toolUse',
        },
        {
          role: 'toolResult',
          toolCallId: 'read-1',
          toolName: 'read',
          content: 'messages',
        },
        {
          role: 'assistant',
          id: 'final-with-process-prefix',
          content: `${processNarration} ${finalReply}`,
          stopReason: 'stop',
        },
      ],
      loading: false,
      error: null,
      runError: null,
      sending: false,
      activeRunId: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      runAborted: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      sessions: [{ key: 'agent:main:main' }],
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      sessionLabels: {},
      sessionLastActivity: {},
      thinkingLevel: null,
      sessionBackendActivity: null,
      gatewayBackgroundActivity: null,
    });

    const { Chat } = await import('@/pages/Chat/index');
    render(<Chat />);

    const bubble = screen.getByTestId('chat-message-3');
    expect(bubble).toHaveTextContent(finalReply);
    expect(bubble).not.toHaveTextContent(processNarration);
  });
});
