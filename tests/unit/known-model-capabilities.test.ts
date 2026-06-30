import { describe, expect, it } from 'vitest';
import {
  applyKnownModelCapabilityOverrides,
  DEEPSEEK_V4_CONTEXT_WINDOW,
  DEEPSEEK_V4_MAX_OUTPUT_TOKENS,
  isDeepSeekV4ModelId,
  sanitizeOpenClawModelInput,
  syncOpenClawModelCatalogEntry,
} from '@electron/services/providers/known-model-capabilities';

describe('known-model-capabilities', () => {
  it('detects DeepSeek V4 model ids', () => {
    expect(isDeepSeekV4ModelId('deepseek-v4-pro')).toBe(true);
    expect(isDeepSeekV4ModelId('deepseek-v4-flash')).toBe(true);
    expect(isDeepSeekV4ModelId('deepseek/deepseek-v4-pro')).toBe(true);
    expect(isDeepSeekV4ModelId('deepseek-chat')).toBe(false);
    expect(isDeepSeekV4ModelId('MiniMax-M2.7')).toBe(false);
  });

  it('applies DeepSeek V4 output limits to model entries', () => {
    const result = applyKnownModelCapabilityOverrides('deepseek-v4-pro', {
      id: 'deepseek-v4-pro',
      name: 'deepseek-v4-pro',
    }, 'https://api.deepseek.com');

    expect(result).toEqual({
      id: 'deepseek-v4-pro',
      name: 'deepseek-v4-pro',
      contextWindow: DEEPSEEK_V4_CONTEXT_WINDOW,
      contextTokens: DEEPSEEK_V4_CONTEXT_WINDOW,
      maxTokens: DEEPSEEK_V4_MAX_OUTPUT_TOKENS,
      compat: { maxTokensField: 'max_tokens' },
    });
  });

  it('sets max_tokens field for any custom provider base URL', () => {
    const result = syncOpenClawModelCatalogEntry('my-model', {
      id: 'my-model',
      contextWindow: 32000,
    }, { baseUrl: 'http://127.0.0.1:11434/v1' });

    expect(result).toMatchObject({
      id: 'my-model',
      contextWindow: 32000,
      contextTokens: 32000,
      compat: { maxTokensField: 'max_tokens' },
    });
  });

  it('applies default max_tokens compat for unknown models without catalog limits', () => {
    const entry = { id: 'qwen3.5-397b', name: 'qwen3.5-397b' };
    expect(applyKnownModelCapabilityOverrides('qwen3.5-397b', entry)).toEqual({
      ...entry,
      compat: { maxTokensField: 'max_tokens' },
    });
  });

  it('strips unsupported input modalities for OpenClaw models.json schema', () => {
    expect(sanitizeOpenClawModelInput(['text', 'image', 'video'])).toEqual(['text', 'image']);
    expect(sanitizeOpenClawModelInput(['video'])).toEqual(['text']);
  });
});
