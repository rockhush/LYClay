import { describe, expect, it } from 'vitest';
import {
  isSyntheticSessionLabelUserMessage,
  stripSyntheticSessionLabelUserMessages,
} from '@/stores/chat/helpers';
import type { RawMessage } from '@/stores/chat/types';

const SESSION_KEY = 'agent:main:session-a';

describe('synthetic session label user messages', () => {
  it('detects placeholder bubbles synthesized from sidebar labels', () => {
    const synthetic: RawMessage = {
      role: 'user',
      id: `local-${SESSION_KEY}`,
      content: 'truncated question start',
    };
    const real: RawMessage = {
      role: 'user',
      id: 'real-user-id',
      content: 'full question text',
    };

    expect(isSyntheticSessionLabelUserMessage(synthetic, SESSION_KEY)).toBe(true);
    expect(isSyntheticSessionLabelUserMessage(real, SESSION_KEY)).toBe(false);
  });

  it('strips synthetic placeholders while keeping real user messages', () => {
    const messages: RawMessage[] = [
      {
        role: 'user',
        id: `local-${SESSION_KEY}`,
        content: 'truncated question start',
      },
      {
        role: 'user',
        id: 'real-user-id',
        content: 'full question text',
      },
      {
        role: 'assistant',
        content: 'answer',
      },
    ];

    expect(stripSyntheticSessionLabelUserMessages(messages, SESSION_KEY)).toEqual([
      messages[1],
      messages[2],
    ]);
  });
});
