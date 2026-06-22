import { describe, expect, it } from 'vitest';
import {
  buildTranscriptTimingMaps,
  enrichMessagesWithModelCallDurations,
} from '@/stores/chat/transcript-timing';
import type { RawMessage } from '@/stores/chat/types';

describe('transcript timing', () => {
  it('derives model call duration from gaps before assistant turns', () => {
    const messages: RawMessage[] = [
      { role: 'user', id: 'u1', timestamp: 1_000, content: 'hi' },
      { role: 'assistant', id: 'a1', timestamp: 4_000, content: [{ type: 'toolCall', id: 't1', name: 'read', arguments: {} }] },
      { role: 'toolresult', id: 'r1', timestamp: 4_500, toolCallId: 't1', content: 'ok', details: { durationMs: 120 } },
      { role: 'assistant', id: 'a2', timestamp: 7_000, content: [{ type: 'text', text: 'done' }] },
    ];

    const enriched = enrichMessagesWithModelCallDurations(messages);
    expect(enriched[1]?._modelCallDurationMs).toBe(3_000);
    expect(enriched[3]?._modelCallDurationMs).toBe(2_500);

    const maps = buildTranscriptTimingMaps(messages);
    expect(maps.toolDurationByToolCallId.get('t1')).toBe(120);
  });

  it('derives model call duration from ISO envelope timestamps', () => {
    const messages: RawMessage[] = [
      { role: 'toolresult', id: 'r1', timestamp: '2026-06-22T03:09:03.899Z', toolCallId: 't1', content: 'ok', details: { durationMs: 2682 } },
      { role: 'assistant', id: 'a2', timestamp: '2026-06-22T03:09:52.702Z', content: [{ type: 'thinking', thinking: 'rewrite script' }] },
    ];

    const enriched = enrichMessagesWithModelCallDurations(messages);
    expect(enriched[1]?._modelCallDurationMs).toBe(48_803);
    expect(buildTranscriptTimingMaps(messages).toolDurationByToolCallId.get('t1')).toBe(2682);
  });
});
