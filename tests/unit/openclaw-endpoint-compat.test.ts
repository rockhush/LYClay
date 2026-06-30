import { describe, expect, it } from 'vitest';
import {
  resolveMaxTokensFieldForBaseUrl,
  resolveOpenClawEndpointClass,
} from '@electron/services/providers/openclaw-endpoint-compat';

describe('openclaw-endpoint-compat', () => {
  it('classifies DeepSeek native endpoint', () => {
    expect(resolveOpenClawEndpointClass('https://api.deepseek.com')).toBe('deepseek-native');
    expect(resolveMaxTokensFieldForBaseUrl('https://api.deepseek.com')).toBe('max_tokens');
  });

  it('classifies OpenAI first-party endpoints as max_completion_tokens', () => {
    expect(resolveOpenClawEndpointClass('https://api.openai.com/v1')).toBe('openai-public');
    expect(resolveMaxTokensFieldForBaseUrl('https://api.openai.com/v1')).toBe('max_completion_tokens');
  });

  it('defaults custom and local OpenAI-compatible proxies to max_tokens', () => {
    expect(resolveOpenClawEndpointClass('http://127.0.0.1:8000/v1')).toBe('local');
    expect(resolveMaxTokensFieldForBaseUrl('http://127.0.0.1:8000/v1')).toBe('max_tokens');
    expect(resolveOpenClawEndpointClass('https://nginx.internal.example/v1')).toBe('custom');
    expect(resolveMaxTokensFieldForBaseUrl('https://nginx.internal.example/v1')).toBe('max_tokens');
  });
});
