import { describe, expect, it } from 'vitest';
import {
  buildLyAutoModelOverrides,
  normalizeLyAutoInput,
} from '@electron/services/providers/ly-auto-compile-parity';

describe('ly-auto-compile-parity', () => {
  it('defaults ly-auto model overrides to text+image input', () => {
    expect(buildLyAutoModelOverrides()).toMatchObject({
      input: ['text', 'image'],
      compat: {
        supportsUsageInStreaming: true,
        supportsPromptCacheKey: false,
      },
    });
  });

  it('uses nginx input modalities without copying reasoning/context', () => {
    expect(buildLyAutoModelOverrides({ input: ['text', 'image', 'audio'] })).toEqual({
      compat: {
        supportsUsageInStreaming: true,
        supportsPromptCacheKey: false,
      },
      input: ['text', 'image', 'audio'],
    });
  });

  it('falls back when nginx input is empty', () => {
    expect(normalizeLyAutoInput([])).toEqual(['text', 'image']);
    expect(normalizeLyAutoInput(undefined)).toEqual(['text', 'image']);
  });
});
