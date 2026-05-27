import { describe, expect, it, vi } from 'vitest';
import { compressHistory } from '@/stores/chat/context-compactor';
import type { RawMessage } from '@/stores/chat/types';

function makeMessages(count: number, contentLength: number): RawMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: '测'.repeat(contentLength),
    id: `msg-${index}`,
  }));
}

describe('compressHistory', () => {
  it('returns null when history does not need compression', async () => {
    const invokeRpc = vi.fn();

    const result = await compressHistory(
      makeMessages(2, 10),
      'session-a',
      invokeRpc,
      { threshold: 1000, minMessageCount: 10 },
    );

    expect(result).toBeNull();
    expect(invokeRpc).not.toHaveBeenCalled();
  });

  it('uses dynamic keepRecentTokens and calls the summarizer', async () => {
    const invokeRpc = vi.fn().mockResolvedValue({
      success: true,
      result: { message: { content: '摘要内容' } },
    });

    const result = await compressHistory(
      makeMessages(8, 100),
      'session-b',
      invokeRpc,
      {
        threshold: 10,
        minMessageCount: 2,
        keepRecentTokens: 80,
        minRoundsBetweenCompression: 0,
        summaryTokens: 2000,
        hardLimitTokens: 10000,
      },
    );

    expect(result).not.toBeNull();
    expect(invokeRpc).toHaveBeenCalledWith(
      'chat.send',
      expect.objectContaining({ sessionKey: '__compactor__', deliver: false }),
      60000,
    );
    expect(result!.summaryMessage.role).toBe('system');
    expect(String(result!.summaryMessage.content)).toContain('摘要内容');
    expect(result!.compressedMessages.length).toBeLessThan(8);
  });

  it('uses an explicit fallback message when summarization fails', async () => {
    const invokeRpc = vi.fn().mockRejectedValue(new Error('fail'));

    const result = await compressHistory(
      makeMessages(8, 100),
      'session-c',
      invokeRpc,
      {
        threshold: 10,
        minMessageCount: 2,
        keepRecentTokens: 80,
        minRoundsBetweenCompression: 0,
        hardLimitTokens: 10000,
      },
    );

    expect(result).not.toBeNull();
    expect(String(result!.summaryMessage.content)).toContain('上下文压缩失败');
    expect(String(result!.summaryMessage.content)).toContain('未进入本次请求');
  });
});
