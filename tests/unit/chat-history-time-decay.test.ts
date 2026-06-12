import { describe, expect, it } from 'vitest';
import { applyTimeDecayStrategy } from '@/stores/chat/history-time-decay';
import type { RawMessage } from '@/stores/chat/types';

function userMsg(text: string, ts: number): RawMessage {
  return { role: 'user', content: text, timestamp: ts } as RawMessage;
}

function assistantMsg(text: string, ts: number): RawMessage {
  return { role: 'assistant', content: text, timestamp: ts } as RawMessage;
}

function toolResultMsg(text: string, ts: number): RawMessage {
  return { role: 'toolresult', content: text, timestamp: ts } as RawMessage;
}

describe('history time decay — never drops Q&A on reload', () => {
  it('keeps all user/assistant turns even for an old session over the message limit', () => {
    // 168h+ ago → messageLimit = 15. Build many tool results plus a full Q&A.
    const longAgo = Date.now() - 200 * 3600 * 1000;
    const messages: RawMessage[] = [];
    // 3 question/answer pairs interleaved with many small tool results.
    for (let i = 0; i < 3; i++) {
      messages.push(userMsg(`问题${i + 1}`, longAgo + i * 1000));
      for (let j = 0; j < 20; j++) {
        messages.push(toolResultMsg(`tool-${i}-${j}`, longAgo + i * 1000 + j));
      }
      messages.push(assistantMsg(`回答${i + 1}`, longAgo + i * 1000 + 999));
    }

    const { messages: result } = applyTimeDecayStrategy(messages, longAgo);

    const conversational = result.filter((m) => m.role === 'user' || m.role === 'assistant');
    expect(conversational).toHaveLength(6);
    expect(conversational.map((m) => m.content)).toEqual([
      '问题1', '回答1', '问题2', '回答2', '问题3', '回答3',
    ]);
  });

  it('keeps the earliest question even when large tool outputs blow the token budget', () => {
    const longAgo = Date.now() - 200 * 3600 * 1000;
    const huge = 'x'.repeat(200_000); // far beyond any token budget
    const messages: RawMessage[] = [
      userMsg('斯诺克历史第一人', longAgo),
      assistantMsg('这里是很长的回答……', longAgo + 1),
      userMsg('赛车F1史上最伟大运动员', longAgo + 2),
      // small tool result kept; large one filtered by L2 anyway
      toolResultMsg(huge, longAgo + 3),
      assistantMsg('详细分析……', longAgo + 4),
    ];

    const { messages: result } = applyTimeDecayStrategy(messages, longAgo);
    const conversational = result.filter((m) => m.role === 'user' || m.role === 'assistant');
    expect(conversational.map((m) => m.content)).toEqual([
      '斯诺克历史第一人', '这里是很长的回答……', '赛车F1史上最伟大运动员', '详细分析……',
    ]);
  });
});
