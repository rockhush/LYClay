import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api-client', () => ({
  hostApiFetch: vi.fn(),
  invokeIpc: vi.fn(),
}));

vi.mock('@/lib/image-cache', () => ({
  clearImageCache: vi.fn(),
  getCachedImage: vi.fn(),
  setCachedImage: vi.fn(),
}));

describe('chat reasoning normalization', () => {
  it('normalizes top-level DeepSeek reasoning_content into thinking blocks', async () => {
    const { normalizeStreamingMessage } = await import('@/stores/chat/helpers');

    const normalized = normalizeStreamingMessage({
      role: 'assistant',
      reasoning_content: '正在分析数据结构',
      content: '现在开始实现',
    }) as { content: Array<{ type: string; thinking?: string; text?: string }>; reasoning_content?: string };

    expect(normalized.reasoning_content).toBeUndefined();
    expect(normalized.content).toEqual([
      { type: 'thinking', thinking: '正在分析数据结构' },
      { type: 'text', text: '现在开始实现' },
    ]);
  });

  it('normalizes OpenAI-compatible nested delta reasoning_content', async () => {
    const { normalizeStreamingMessage } = await import('@/stores/chat/helpers');

    const normalized = normalizeStreamingMessage({
      role: 'assistant',
      choices: [
        {
          delta: {
            reasoning_content: '先定位插入点',
          },
        },
      ],
      content: [{ type: 'text', text: '继续处理' }],
    }) as { content: Array<{ type: string; thinking?: string; text?: string }> };

    expect(normalized.content[0]).toEqual({ type: 'thinking', thinking: '先定位插入点' });
    expect(normalized.content[1]).toEqual({ type: 'text', text: '继续处理' });
  });

  it('normalizes reasoning content blocks without duplicating existing thinking', async () => {
    const { normalizeStreamingMessage } = await import('@/stores/chat/helpers');

    const normalized = normalizeStreamingMessage({
      role: 'assistant',
      reasoning_content: '同一段推理',
      content: [
        { type: 'reasoning', text: '分块生成 JS 模块' },
        { type: 'thinking', thinking: '同一段推理' },
      ],
    }) as { content: Array<{ type: string; thinking?: string }> };

    expect(normalized.content).toEqual([
      { type: 'thinking', text: '分块生成 JS 模块', thinking: '分块生成 JS 模块' },
      { type: 'thinking', thinking: '同一段推理' },
    ]);
  });
});

describe('complex task control prompt visibility', () => {
  it('restores the planning control prompt to the original user request and hides duplicate execution control prompt', async () => {
    const { normalizeComplexTaskControlUserMessages } = await import('@/stores/chat/helpers');

    const messages = normalizeComplexTaskControlUserMessages([
      {
        role: 'user',
        content: [
          '[LYClaw complex task planning phase]',
          '你现在只做规划握手，不要开始实现。',
          '',
          '用户原始需求：',
          '做一个问卷分析看板',
        ].join('\n'),
      },
      {
        role: 'assistant',
        content: '我会分步骤执行。',
      },
      {
        role: 'user',
        content: [
          '[LYClaw staged execution phase]',
          '请按上一步计划开始执行。',
          '',
          '用户原始需求：',
          '做一个问卷分析看板',
        ].join('\n'),
      },
    ]);

    expect(messages).toEqual([
      {
        role: 'user',
        content: '做一个问卷分析看板',
      },
      {
        role: 'assistant',
        content: '我会分步骤执行。',
      },
    ]);
  });
});
