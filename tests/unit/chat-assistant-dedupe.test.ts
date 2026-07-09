import { describe, expect, it } from 'vitest';
import {
  areEquivalentAssistantMessageTexts,
  assistantTextMatchesNormalized,
  dedupeAssistantMessagesByContent,
} from '@/stores/chat/helpers';
import type { RawMessage } from '@/stores/chat/types';

describe('assistant message dedupe', () => {
  it('treats assistant messages with identical visible text as equivalent', () => {
    const first: RawMessage = { role: 'assistant', content: '好的，确认完毕。现在调用 FACA 接口' };
    const second: RawMessage = { role: 'assistant', id: 'run-2', content: '好的，确认完毕。现在调用 FACA 接口' };
    expect(areEquivalentAssistantMessageTexts(first, second)).toBe(true);
  });

  it('keeps only the latest duplicate assistant message within a user turn', () => {
    const messages: RawMessage[] = [
      { role: 'user', content: '生成报告' },
      { role: 'assistant', id: 'a-1', content: '好的，确认完毕。现在调用 FACA 接口' },
      { role: 'assistant', id: 'a-2', content: '好的，确认完毕。现在调用 FACA 接口' },
    ];

    const deduped = dedupeAssistantMessagesByContent(messages);
    expect(deduped).toHaveLength(2);
    expect(deduped[1]?.id).toBe('a-2');
  });

  it('does not collapse duplicate assistant text across different user turns', () => {
    const messages: RawMessage[] = [
      { role: 'user', content: '第一次提问' },
      { role: 'assistant', content: '相同回答' },
      { role: 'user', content: '第二次提问' },
      { role: 'assistant', content: '相同回答' },
    ];

    const deduped = dedupeAssistantMessagesByContent(messages);
    expect(deduped).toHaveLength(4);
  });

  it('matches normalized assistant text for streaming duplicate checks', () => {
    const message: RawMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: '  好的，确认完毕。  ' }],
    };
    expect(assistantTextMatchesNormalized(message, '好的，确认完毕。')).toBe(true);
  });
});
