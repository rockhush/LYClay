import { describe, expect, it } from 'vitest';
import {
  detectMentionedSkillIds,
  extractInvokedSkillIds,
  extractTokenConsumeFromAssistantMessage,
  extractTotalTokensFromUsage,
} from '@/stores/chat/usage-report-extract';
import type { RawMessage } from '@/stores/chat/types';

describe('extractTotalTokensFromUsage', () => {
  it('prefers explicit total_tokens', () => {
    expect(extractTotalTokensFromUsage({ total_tokens: 150, input_tokens: 50, output_tokens: 25 })).toBe(150);
  });

  it('falls back to input + output sums when total missing', () => {
    expect(extractTotalTokensFromUsage({ input_tokens: 80, output_tokens: 20 })).toBe(100);
    expect(extractTotalTokensFromUsage({ promptTokens: 60, completionTokens: 40 })).toBe(100);
  });

  it('returns 0 for invalid / negative inputs', () => {
    expect(extractTotalTokensFromUsage(undefined)).toBe(0);
    expect(extractTotalTokensFromUsage(null)).toBe(0);
    expect(extractTotalTokensFromUsage('not-an-object')).toBe(0);
    expect(extractTotalTokensFromUsage({ total_tokens: -5 })).toBe(0);
  });
});

describe('extractTokenConsumeFromAssistantMessage', () => {
  it('returns null when message is not assistant role', () => {
    const userMsg: RawMessage = {
      role: 'user',
      content: 'hello',
    };
    expect(extractTokenConsumeFromAssistantMessage(userMsg)).toBeNull();
  });

  it('returns null when usage payload is missing', () => {
    const msg = { role: 'assistant', content: 'hi', model: 'gpt-4o-mini' } as unknown as RawMessage;
    expect(extractTokenConsumeFromAssistantMessage(msg)).toBeNull();
  });

  it('extracts model + total tokens', () => {
    const msg = {
      role: 'assistant',
      content: 'final reply',
      model: 'gpt-4o-mini',
      usage: { total_tokens: 1500 },
    } as unknown as RawMessage;
    expect(extractTokenConsumeFromAssistantMessage(msg)).toEqual({
      model: 'gpt-4o-mini',
      consume: 1500,
    });
  });

  it('falls back to modelRef when model field is missing', () => {
    const msg = {
      role: 'assistant',
      content: 'reply',
      modelRef: 'claude-sonnet-4',
      usage: { input_tokens: 10, output_tokens: 20 },
    } as unknown as RawMessage;
    expect(extractTokenConsumeFromAssistantMessage(msg)).toEqual({
      model: 'claude-sonnet-4',
      consume: 30,
    });
  });

  it('returns null when no model identifier is present', () => {
    const msg = {
      role: 'assistant',
      content: 'reply',
      usage: { total_tokens: 50 },
    } as unknown as RawMessage;
    expect(extractTokenConsumeFromAssistantMessage(msg)).toBeNull();
  });
});

describe('extractInvokedSkillIds', () => {
  it('returns empty array when no tool_use blocks present', () => {
    expect(extractInvokedSkillIds(null)).toEqual([]);
    expect(extractInvokedSkillIds({ role: 'assistant', content: 'plain text' } as RawMessage)).toEqual([]);
  });

  it('extracts skill ids and tool call ids from tool_use blocks', () => {
    const msg: RawMessage = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'thinking...' },
        { type: 'tool_use', id: 'call-1', name: 'pdf', input: { file: 'a.pdf' } },
        { type: 'toolCall', id: 'call-2', name: 'web-search' },
        { type: 'tool_use', name: 'docx' }, // missing id
      ],
    };
    expect(extractInvokedSkillIds(msg)).toEqual([
      { skillId: 'pdf', toolCallId: 'call-1' },
      { skillId: 'web-search', toolCallId: 'call-2' },
      { skillId: 'docx', toolCallId: 'docx-2' },
    ]);
  });

  it('skips tool_use blocks without a name', () => {
    const msg: RawMessage = {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'call-1' },
        { type: 'tool_use', id: 'call-2', name: '   ' },
      ],
    };
    expect(extractInvokedSkillIds(msg)).toEqual([]);
  });

  it('extracts OpenAI-style tool_calls (function.name)', () => {
    const msg = {
      role: 'assistant',
      content: 'I need to translate that.',
      tool_calls: [
        {
          id: 'call_abc',
          type: 'function',
          function: { name: 'cn-translate', arguments: '{"text":"哥哥"}' },
        },
        {
          id: 'call_def',
          function: { name: 'web-search' },
        },
      ],
    } as unknown as RawMessage;
    expect(extractInvokedSkillIds(msg)).toEqual([
      { skillId: 'cn-translate', toolCallId: 'call_abc' },
      { skillId: 'web-search', toolCallId: 'call_def' },
    ]);
  });

  it('extracts OpenAI-style toolCalls camelCase variant with top-level name', () => {
    const msg = {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'tc-1', name: 'pdf-extract' },
      ],
    } as unknown as RawMessage;
    expect(extractInvokedSkillIds(msg)).toEqual([
      { skillId: 'pdf-extract', toolCallId: 'tc-1' },
    ]);
  });

  it('detects @-mentions in text and returns matching skill ids', () => {
    const skills = [
      { id: 'cn-translate-key', name: 'cn-translate' },
      { id: 'market-analysis-ch-key', name: 'market-analysis-ch' },
      { id: 'web-search', name: 'web-search' },
    ];
    expect(detectMentionedSkillIds('@cn-translate 哥哥、弟弟', skills)).toEqual(['cn-translate-key']);
    expect(detectMentionedSkillIds('@market-analysis-ch 茶饮赛道', skills)).toEqual(['market-analysis-ch-key']);
  });

  it('mention scan is case-insensitive but respects word boundary', () => {
    const skills = [{ id: 'cn-translate', name: 'cn-translate' }];
    expect(detectMentionedSkillIds('@CN-TRANSLATE hello', skills)).toEqual(['cn-translate']);
    // No false positive: @cn-translate-fast should NOT match `cn-translate`.
    expect(detectMentionedSkillIds('@cn-translate-fast hi', skills)).toEqual([]);
  });

  it('mention scan prefers longest-name match (no @market when @market-analysis-ch is present)', () => {
    const skills = [
      { id: 'market', name: 'market' },
      { id: 'market-analysis-ch', name: 'market-analysis-ch' },
    ];
    expect(detectMentionedSkillIds('@market-analysis-ch please', skills)).toEqual(['market-analysis-ch']);
  });

  it('mention scan matches skill id/slug when display name differs', () => {
    expect(detectMentionedSkillIds(
      '@dws 请使用这个技能，帮我',
      [{ id: 'dws', slug: 'dws', name: '办公助手（日程、钉盘、表格、消息）' }],
    )).toEqual(['dws']);
  });

  it('mention scan returns empty for missing/blank inputs', () => {
    expect(detectMentionedSkillIds('', [{ id: 'a', name: 'a' }])).toEqual([]);
    expect(detectMentionedSkillIds('@a', [])).toEqual([]);
    expect(detectMentionedSkillIds('hello world', [{ id: 'a', name: 'a' }])).toEqual([]);
  });

  it('merges Anthropic content blocks AND OpenAI tool_calls in the same message', () => {
    const msg = {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'call-1', name: 'pdf' },
      ],
      tool_calls: [
        { id: 'call_2', function: { name: 'docx' } },
      ],
    } as unknown as RawMessage;
    expect(extractInvokedSkillIds(msg)).toEqual([
      { skillId: 'pdf', toolCallId: 'call-1' },
      { skillId: 'docx', toolCallId: 'call_2' },
    ]);
  });
});
