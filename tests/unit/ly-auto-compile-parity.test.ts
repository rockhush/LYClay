import { describe, expect, it } from 'vitest';
import {
  buildLyAutoModelOverrides,
  LY_AUTO_REQUEST_TIMEOUT_SECONDS,
  normalizeLyAutoInput,
} from '@electron/services/providers/ly-auto-compile-parity';

describe('ly-auto-compile-parity', () => {
  it('defaults ly-auto model overrides to text+image input', () => {
    const overrides = buildLyAutoModelOverrides();

    expect(overrides).toEqual({
      compat: {
        supportsUsageInStreaming: true,
        supportsPromptCacheKey: false,
        thinkingFormat: 'qwen-chat-template',
      },
      reasoning: true,
      input: ['text', 'image'],
    });
    expect(overrides).not.toHaveProperty('requestTimeoutMs');
  });

  it('uses nginx input modalities without copying reasoning/context', () => {
    expect(buildLyAutoModelOverrides({ input: ['text', 'image', 'audio'] })).toEqual({
      compat: {
        supportsUsageInStreaming: true,
        supportsPromptCacheKey: false,
        thinkingFormat: 'qwen-chat-template',
      },
      reasoning: true,
      input: ['text', 'image', 'audio'],
    });
  });

  it('keeps the request timeout as provider-level configuration', () => {
    expect(LY_AUTO_REQUEST_TIMEOUT_SECONDS).toBe(180);
  });

  it('falls back when nginx input is empty', () => {
    expect(normalizeLyAutoInput([])).toEqual(['text', 'image']);
    expect(normalizeLyAutoInput(undefined)).toEqual(['text', 'image']);
  });
});
