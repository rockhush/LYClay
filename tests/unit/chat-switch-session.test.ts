import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/ui-state-persistence', () => ({
  hydrateUiStateFromDisk: vi.fn(),
}));
vi.mock('@/lib/host-api', () => ({
  hostApiFetch: vi.fn(),
}));

import { useChatStore } from '@/stores/chat';

describe('useChatStore switchSession', () => {
  beforeEach(() => {
    useChatStore.setState({
      currentSessionKey: 'agent:foo:session-a',
      sessions: [{ key: 'agent:foo:session-a' }, { key: 'agent:foo:main' }],
      messages: [{ role: 'assistant', content: '已完成的答案' }],
      sessionLabels: { 'agent:foo:session-a': 'A' },
      sessionLastActivity: { 'agent:foo:session-a': 1 },
      sessionStreamingStates: {},
      activeRunId: null,
      sending: false,
      error: null,
      pendingFinal: false,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      lastUserMessageAt: null,
      pendingToolImages: [],
      runAborted: false,
      runError: null,
      loading: false,
      loadHistory: vi.fn(),
    } as any);
  });

  it('preserves completed session messages when switching away and restores them on switch back', () => {
    const sessionA = 'agent:foo:session-a';
    const sessionB = 'agent:foo:main';

    useChatStore.getState().switchSession(sessionB);

    expect(useChatStore.getState().sessionStreamingStates[sessionA]?.messagesSnapshot)
      .toEqual([{ role: 'assistant', content: '已完成的答案' }]);
    expect(useChatStore.getState().loadHistory).toHaveBeenCalledTimes(1);

    useChatStore.getState().switchSession(sessionA);
    expect(useChatStore.getState().messages).toEqual([{ role: 'assistant', content: '已完成的答案' }]);
  });
});
