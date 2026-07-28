import { describe, expect, it } from 'vitest';
import { extractUsageTokensFromMessage, parseUsageTokensFromShape } from '@/lib/token-usage-parse';

describe('parseUsageTokensFromShape', () => {
  it('reads input/output/cache fields the same way as Models token history', () => {
    expect(parseUsageTokensFromShape({
      input: 13936,
      output: 454,
      cacheRead: 12672,
    })).toEqual({
      inputTokens: 13936,
      outputTokens: 454,
      cacheReadTokens: 12672,
    });
  });

  it('reads nested cache read tokens from prompt_tokens_details', () => {
    expect(parseUsageTokensFromShape({
      input_tokens: 100,
      output_tokens: 20,
      prompt_tokens_details: { cached_tokens: 80 },
    })).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 80,
    });
  });
});

describe('extractUsageTokensFromMessage', () => {
  it('extracts usage from assistant message.usage', () => {
    expect(extractUsageTokensFromMessage({
      role: 'assistant',
      content: 'ok',
      usage: { input: 10, output: 2, cache_read: 5 },
    })).toEqual({
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 5,
    });
  });
});
