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

    expect(screen.queryByTestId('chat-execution-graph')).not.toBeInTheDocument();
    expect(screen.queryByTestId('chat-execution-step-thinking-trailing')).not.toBeInTheDocument();
  });
});
