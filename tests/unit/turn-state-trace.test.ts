import { describe, expect, it, vi } from 'vitest';
import {
  resetTurnStateTraceForTests,
  summarizeAssistantMessage,
  summarizeTranscriptTail,
  traceTurnDecision,
  traceTurnTransition,
} from '@/stores/chat/turn-state-trace';

vi.mock('@/lib/api-client', () => ({
  appendRendererLog: vi.fn(),
}));

import { appendRendererLog } from '@/lib/api-client';

describe('turn-state-trace', () => {
  it('summarizes assistant messages without dumping full content', () => {
    expect(summarizeAssistantMessage({
      role: 'assistant',
      id: 'a1',
      content: [
        { type: 'text', text: 'All three requests timed out. '.repeat(20) },
        { type: 'tool_use', id: 't1', name: 'exec', input: {} },
      ],
      stopReason: undefined,
      timestamp: 4000,
    })).toMatchObject({
      id: 'a1',
      toolUseCount: 1,
      textPreview: expect.stringContaining('All three requests timed out'),
    });
  });

  it('dedupes repeated derive decisions', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.mocked(appendRendererLog).mockClear();
    resetTurnStateTraceForTests();
    traceTurnDecision('derive-is-executing', true, { reason: 'user_turn_open' }, 'session-1');
    traceTurnDecision('derive-is-executing', true, { reason: 'user_turn_open' }, 'session-1');
    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(appendRendererLog).toHaveBeenCalledTimes(1);
    traceTurnDecision('derive-is-executing', false, { reason: 'transcript_turn_settled' }, 'session-1');
    expect(debugSpy).toHaveBeenCalledTimes(2);
    expect(appendRendererLog).toHaveBeenCalledTimes(2);
    debugSpy.mockRestore();
  });

  it('always logs transitions', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.mocked(appendRendererLog).mockClear();
    traceTurnTransition('runtime-event', { state: 'final', runId: 'r1' });
    traceTurnTransition('runtime-event', { state: 'final', runId: 'r1' });
    expect(debugSpy).toHaveBeenCalledTimes(2);
    expect(appendRendererLog).toHaveBeenCalledTimes(2);
    expect(appendRendererLog).toHaveBeenCalledWith(
      'info',
      '[chat.turn-state] runtime-event',
      { state: 'final', runId: 'r1' },
    );
    debugSpy.mockRestore();
  });

  it('summarizes transcript tail', () => {
    const tail = summarizeTranscriptTail([
      { role: 'user', content: 'hello', id: 'u1' },
      { role: 'assistant', content: 'done', id: 'a1' },
    ], 1000);
    expect(tail.messageCount).toBe(2);
    expect(tail.tail).toHaveLength(2);
  });
});
