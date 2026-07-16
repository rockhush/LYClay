import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/ui-state-persistence', () => ({
  hydrateUiStateFromDisk: vi.fn(),
}));
vi.mock('@/lib/host-api', () => ({
  hostApiFetch: vi.fn(),
}));

import { loadRetiredDigitalEmployees } from '@/lib/retired-digital-employees';
import { useChatStore } from '@/stores/chat';

describe('useChatStore newSession', () => {
  beforeEach(() => {
    loadRetiredDigitalEmployees({ retiredAgents: {} });
    useChatStore.setState({
      currentSessionKey: 'agent:employee-old:main',
      currentAgentId: 'employee-old',
      sessions: [{ key: 'agent:employee-old:main' }],
      messages: [
        { role: 'user', content: 'session A question' },
        { role: 'assistant', content: 'session A answer' },
      ],
      sessionLabels: { 'agent:employee-old:main': '招聘数字员工 @竞品分析助手' },
      sessionLastActivity: { 'agent:employee-old:main': 1 },
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

  it('preserves completed session messages when creating a new digital-employee session', () => {
    const sessionA = 'agent:employee-old:main';

    useChatStore.getState().newSession('employee-new');

    expect(useChatStore.getState().sessionStreamingStates[sessionA]?.messagesSnapshot).toEqual([
      { role: 'user', content: 'session A question' },
      { role: 'assistant', content: 'session A answer' },
    ]);
    expect(useChatStore.getState().currentAgentId).toBe('employee-new');
    expect(useChatStore.getState().messages).toEqual([]);

    useChatStore.getState().switchSession(sessionA);
    expect(useChatStore.getState().messages).toEqual([
      { role: 'user', content: 'session A question' },
      { role: 'assistant', content: 'session A answer' },
    ]);
  });
});
