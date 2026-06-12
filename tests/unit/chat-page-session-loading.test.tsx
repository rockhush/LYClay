/**
 * Session switch clears messages before chat.history resolves; the Chat page must not
 * show the Welcome screen during that window (looks “stuck” until history arrives).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const hostApiFetchMock = vi.fn();

const { gatewayState, agentsState } = vi.hoisted(() => ({
  gatewayState: {
    status: {
      state: 'running',
      port: 18789,
      gatewayReady: true,
      warmupStatus: 'ready',
    } as Record<string, unknown>,
  },
  agentsState: {
    agents: [{ id: 'main', name: 'main' }] as Array<Record<string, unknown>>,
    fetchAgents: vi.fn(),
  },
}));

vi.mock('@/stores/gateway', () => ({
  useGatewayStore: (selector: (state: typeof gatewayState) => unknown) => selector(gatewayState),
}));

vi.mock('@/stores/agents', () => ({
  useAgentsStore: (selector: (state: typeof agentsState) => unknown) => selector(agentsState),
}));

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
}));

vi.mock('@/hooks/use-stick-to-bottom-instant', () => ({
  useStickToBottomInstant: () => ({
    contentRef: { current: null },
    scrollRef: { current: null },
  }),
}));

/** Pass-through so overlay matches `loading` without min-duration extension in tests. */
vi.mock('@/hooks/use-min-loading', () => ({
  useMinLoading: (v: boolean) => v,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      if (key === 'welcome.subtitle') return 'WELCOME_TITLE_UNIQUE';
      return key;
    },
  }),
}));

vi.mock('@/pages/Chat/ChatToolbar', () => ({
  ChatToolbar: () => null,
}));

vi.mock('@/pages/Chat/ChatInput', () => ({
  ChatInput: () => null,
}));

describe('Chat session history loading UI', () => {
  beforeEach(async () => {
    vi.resetModules();
    hostApiFetchMock.mockResolvedValue({ success: true, messages: [] });

    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState({
      messages: [],
      loading: true,
      error: null,
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
      isFirstMessageEver: false,
      loadHistory: vi.fn(),
      cleanupEmptySession: vi.fn(),
    });
  });

  it('shows history loading overlay and not the welcome screen when thread is empty but loading', async () => {
    const { Chat } = await import('@/pages/Chat');
    render(<Chat />);

    expect(screen.queryByText('WELCOME_TITLE_UNIQUE')).toBeNull();
    expect(screen.getByTestId('chat-history-loading-overlay')).toBeInTheDocument();
  });
});
