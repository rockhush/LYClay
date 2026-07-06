import { describe, expect, it } from 'vitest';
import { transcriptEntriesShowDelegationYield } from '@electron/gateway/transcript-delegation-signals';

describe('transcript-delegation-signals', () => {
  it('detects spawn + yield in the same user turn', () => {
    const entries = [
      {
        type: 'message',
        message: {
          role: 'user',
          idempotencyKey: 'run-abc:user',
          content: 'use sub-agent',
        },
      },
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', name: 'sessions_spawn', id: 'call_spawn' }],
        },
      },
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', name: 'sessions_yield', id: 'call_yield' }],
        },
      },
    ];

    expect(transcriptEntriesShowDelegationYield(entries, 'run-abc')).toBe(true);
  });

  it('returns false for plain text-only assistant turns', () => {
    const entries = [
      {
        type: 'message',
        message: { role: 'user', content: 'hello', idempotencyKey: 'run-plain:user' },
      },
      {
        type: 'message',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] },
      },
    ];

    expect(transcriptEntriesShowDelegationYield(entries, 'run-plain')).toBe(false);
  });

  it('detects yield via custom_message marker', () => {
    const entries = [
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', name: 'sessions_spawn', id: 'call_spawn' }],
        },
      },
      { type: 'custom_message', customType: 'openclaw.sessions_yield' },
    ];

    expect(transcriptEntriesShowDelegationYield(entries)).toBe(true);
  });
});
