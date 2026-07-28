import { describe, expect, it } from 'vitest';
import { countVisibleUserTurns } from '@/stores/chat/run-lifecycle';
import type { RawMessage } from '@/stores/chat/types';

describe('countVisibleUserTurns', () => {
  const sessionKey = 'agent:main:session-123';

  it('returns 1 for the first real user question in a new session', () => {
    const messages: RawMessage[] = [
      { role: 'user', content: 'NBA历史第一人是谁', id: 'u1', timestamp: 1 },
    ];
    expect(countVisibleUserTurns(messages, sessionKey)).toBe(1);
  });

  it('returns 2 for the second question in the same session', () => {
    const messages: RawMessage[] = [
      { role: 'user', content: 'NBA历史第一人是谁', id: 'u1', timestamp: 1 },
      { role: 'assistant', content: '乔丹', timestamp: 2 },
      { role: 'user', content: '科比和詹姆斯对比', id: 'u2', timestamp: 3 },
    ];
    expect(countVisibleUserTurns(messages, sessionKey)).toBe(2);
  });

  it('ignores synthetic sidebar label placeholders and does not add an extra turn', () => {
    const messages: RawMessage[] = [
      { role: 'user', content: 'NBA历史第一人是谁', id: `local-${sessionKey}`, timestamp: 0 },
      { role: 'user', content: 'NBA历史第一人是谁', id: 'u1', timestamp: 1 },
    ];
    expect(countVisibleUserTurns(messages, sessionKey)).toBe(1);
  });
});
