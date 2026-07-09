import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  proxyAwareFetch: vi.fn(),
}));

vi.mock('@electron/utils/proxy-fetch', () => ({
  proxyAwareFetch: mocks.proxyAwareFetch,
}));

import { createSub2ApiClient, Sub2ApiClientError } from '../../electron/services/sub2api/sub2api-client';

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Sub2API client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.proxyAwareFetch.mockResolvedValue(jsonResponse({
      code: 0,
      message: 'ok',
      data: {
        userNo: 'EMP001',
        userId: 10,
        provider: {
          providerId: 'sub2api',
          protocol: 'openai-compatible',
          baseUrl: 'https://sub2api.internal.example.com/v1',
          timeoutSeconds: 600,
        },
        credentials: [{
          apiKeyId: 10,
          apiKeyName: 'main',
          apiKey: 'sk-test',
          groupId: 13,
          groupName: 'test',
          models: ['deepseek-v4-pro'],
        }],
      },
    }));
  });

  it('posts by username with x-api-key and timeout signal', async () => {
    const client = createSub2ApiClient({
      baseUrl: 'https://sub2api.internal.example.com',
      adminApiKey: 'admin-key',
      timeoutMs: 5000,
    });

    const result = await client.fetchUserProviderByUsername('EMP001');

    expect(result.credentials[0]).toMatchObject({
      credentialId: 'apiKey-10',
      apiKey: 'sk-test',
      baseUrl: 'https://sub2api.internal.example.com/v1',
    });
    expect(result.credentials[0].models[0]).toMatchObject({
      modelId: 'deepseek-v4-pro',
      input: ['text', 'image'],
      contextWindow: 200000,
      contextTokens: 200000,
      maxTokens: 16384,
      timeoutSeconds: 600,
      reasoning: true,
      compat: expect.objectContaining({
        supportsUsageInStreaming: true,
        supportsPromptCacheKey: true,
        thinkingFormat: 'qwen-chat-template',
      }),
    });
    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
      'https://sub2api.internal.example.com/api/integration/user-provider/by-username',
      expect.objectContaining({
        method: 'POST',
        signal: expect.any(AbortSignal),
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'x-api-key': 'admin-key',
        }),
        body: JSON.stringify({ userNo: 'EMP001' }),
      }),
    );
  });

  it('accepts the production Sub2API response shape with string models and model gateway port', async () => {
    mocks.proxyAwareFetch.mockResolvedValue(jsonResponse({
      code: 0,
      message: 'ok',
      data: {
        userNo: '11427189',
        userId: 11,
        provider: {
          providerId: 'sub2api',
          protocol: 'openai-compatible',
          baseUrl: 'http://10.0.2.77:8090/v1',
        },
        credentials: [{
          apiKeyId: 21,
          apiKeyName: 'test',
          apiKey: 'sk-test',
          groupId: 29,
          groupName: 'lyclaw-test',
          models: [
            'DeepSeek-R1-Distill-Qwen-14B',
            'MiniMax-M2.7',
            'Qwen2.5-VL-7B-Instruct',
            'qwen3.5-397b',
            'qwen35-122b',
          ],
        }],
      },
    }));
    const client = createSub2ApiClient({
      baseUrl: 'http://10.0.2.77:8081',
      adminApiKey: 'admin-key',
      allowedHosts: ['10.0.2.77'],
    });

    const result = await client.fetchUserProviderByUsername('11427189');

    expect(result.provider.baseUrl).toBe('http://10.0.2.77:8090/v1');
    expect(result.credentials[0]).toMatchObject({
      credentialId: 'apiKey-21',
      apiKey: 'sk-test',
      baseUrl: 'http://10.0.2.77:8090/v1',
    });
    expect(result.credentials[0].models.map((model) => model.modelId)).toEqual([
      'DeepSeek-R1-Distill-Qwen-14B',
      'MiniMax-M2.7',
      'Qwen2.5-VL-7B-Instruct',
      'qwen3.5-397b',
      'qwen35-122b',
    ]);
    expect(result.credentials[0].models[0]).toMatchObject({
      input: ['text', 'image'],
      contextWindow: 200000,
      contextTokens: 200000,
      maxTokens: 16384,
      timeoutSeconds: 900,
      reasoning: true,
    });
  });
  it('maps documented error codes', async () => {
    mocks.proxyAwareFetch.mockResolvedValue(jsonResponse({ code: 40901, message: 'multiple users' }, { status: 409 }));
    const client = createSub2ApiClient({ baseUrl: 'https://sub2api.internal.example.com', adminApiKey: 'admin-key' });

    await expect(client.fetchUserProviderByUsername('EMP')).rejects.toMatchObject({
      code: '40901',
      category: 'ambiguous-user',
      httpStatus: 409,
    });
  });

  it('maps not found responses', async () => {
    mocks.proxyAwareFetch.mockResolvedValue(jsonResponse({ code: 40401, message: 'not found' }, { status: 404 }));
    const client = createSub2ApiClient({ baseUrl: 'https://sub2api.internal.example.com', adminApiKey: 'admin-key' });

    await expect(client.fetchUserProviderByUsername('missing')).rejects.toMatchObject({
      code: '40401',
      category: 'not-found',
    });
  });

  it('maps aborts to timeout without exposing userNo', async () => {
    mocks.proxyAwareFetch.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const client = createSub2ApiClient({ baseUrl: 'https://sub2api.internal.example.com', adminApiKey: 'admin-key' });

    await expect(client.fetchUserProviderByUsername('EMP001')).rejects.toMatchObject({
      code: 'timeout',
      category: 'timeout',
    });
  });

  it('rejects empty credential api keys and disallowed model inputs', async () => {
    mocks.proxyAwareFetch.mockResolvedValue(jsonResponse({
      code: 0,
      message: 'ok',
      data: {
        userNo: 'EMP001',
        userId: 10,
        provider: { providerId: 'sub2api', protocol: 'openai-compatible', baseUrl: 'https://sub2api.internal.example.com/v1' },
        credentials: [{ apiKeyId: 10, apiKeyName: 'main', apiKey: ' ', models: ['model-a'] }],
      },
    }));
    const client = createSub2ApiClient({ baseUrl: 'https://sub2api.internal.example.com', adminApiKey: 'admin-key' });

    await expect(client.fetchUserProviderByUsername('EMP001')).rejects.toBeInstanceOf(Sub2ApiClientError);
  });

  it('skips credentials with modelQueryError and keeps other credentials', async () => {
    mocks.proxyAwareFetch.mockResolvedValue(jsonResponse({
      code: 0,
      message: 'ok',
      data: {
        userNo: 'EMP001',
        userId: 10,
        provider: { providerId: 'sub2api', protocol: 'openai-compatible', baseUrl: 'https://sub2api.internal.example.com/v1' },
        credentials: [
          { apiKeyId: 10, apiKeyName: 'broken', apiKey: 'sk-broken', models: ['broken'], modelQueryError: 'failed' },
          { apiKeyId: 11, apiKeyName: 'ok', apiKey: 'sk-ok', models: [{ modelId: 'vision', displayName: 'Vision', input: ['audio', 'image'] }] },
        ],
      },
    }));
    const client = createSub2ApiClient({ baseUrl: 'https://sub2api.internal.example.com', adminApiKey: 'admin-key' });

    const result = await client.fetchUserProviderByUsername('EMP001');

    expect(result.credentials).toHaveLength(1);
    expect(result.credentials[0].credentialId).toBe('apiKey-11');
    expect(result.credentials[0].models[0]).toMatchObject({
      modelId: 'vision',
      displayName: 'Vision',
      input: ['image'],
    });
  });

  it('falls back to text and image when filtered input is empty', async () => {
    mocks.proxyAwareFetch.mockResolvedValue(jsonResponse({
      code: 0,
      message: 'ok',
      data: {
        userNo: 'EMP001',
        userId: 10,
        provider: { providerId: 'sub2api', protocol: 'openai-compatible', baseUrl: 'https://sub2api.internal.example.com/v1' },
        credentials: [{ apiKeyId: 10, apiKeyName: 'main', apiKey: 'sk-test', models: [{ modelId: 'audio-only', input: ['audio'] }] }],
      },
    }));
    const client = createSub2ApiClient({ baseUrl: 'https://sub2api.internal.example.com', adminApiKey: 'admin-key' });

    const result = await client.fetchUserProviderByUsername('EMP001');

    expect(result.credentials[0].models[0]).toMatchObject({ input: ['text', 'image'] });
  });

  it('rejects disallowed Sub2API admin base URLs', () => {
    expect(() => createSub2ApiClient({
      baseUrl: 'https://evil.example.com',
      adminApiKey: 'admin-key',
      allowedHosts: ['sub2api.internal.example.com'],
    })).toThrow('Sub2API base URL host is not allowed');
  });
});
