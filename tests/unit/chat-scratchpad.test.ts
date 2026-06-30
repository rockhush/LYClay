import { describe, expect, it } from 'vitest';
import { isEmptyChatScratchpad } from '@/lib/chat-scratchpad';

describe('isEmptyChatScratchpad', () => {
  it('returns true for a fresh thread with no metadata', () => {
    expect(isEmptyChatScratchpad('agent:main:main', {
      messages: [],
      sessionLabels: {},
      sessionLastActivity: {},
    })).toBe(true);
  });

  it('returns false when messages exist', () => {
    expect(isEmptyChatScratchpad('agent:main:main', {
      messages: [{ role: 'user', content: 'hi' }],
      sessionLabels: {},
      sessionLastActivity: {},
    })).toBe(false);
  });

  it('returns false when session label or activity is known', () => {
    expect(isEmptyChatScratchpad('agent:main:session-1', {
      messages: [],
      sessionLabels: { 'agent:main:session-1': 'hello' },
      sessionLastActivity: {},
    })).toBe(false);

    expect(isEmptyChatScratchpad('agent:main:session-1', {
      messages: [],
      sessionLabels: {},
      sessionLastActivity: { 'agent:main:session-1': 123 },
    })).toBe(false);
  });
});
