import { describe, expect, it } from 'vitest';
import type { ProviderAccount } from '../../src/lib/providers';
import {
  extractModelIdFromModelRef,
  findProviderItemByModelRef,
  normalizeStoredProviderModel,
  resolveAccountModelRef,
  resolveAccountModelRefs,
  resolveRuntimeProviderKey,
} from '../../src/lib/provider-model-ref';

function customAccount(overrides: Partial<ProviderAccount> = {}): ProviderAccount {
  return {
    id: 'custom-custom6e',
    vendorId: 'custom',
    label: 'Test',
    authMode: 'api_key',
    baseUrl: 'http://localhost/v1',
    apiProtocol: 'openai-completions',
    model: 'mimo-v2.5',
    enabled: true,
    isDefault: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('resolveAccountModelRef', () => {
  it('uses current runtime key when stored model embeds a stale provider prefix', () => {
    const account = customAccount({ model: 'custom-custom64/mimo-v2.5' });
    expect(resolveRuntimeProviderKey(account)).toBe('custom-custom6e');
    expect(resolveAccountModelRef(account)).toBe('custom-custom6e/mimo-v2.5');
  });

  it('builds ref from bare model id', () => {
    const account = customAccount({ model: 'mimo-v2.5' });
    expect(resolveAccountModelRef(account)).toBe('custom-custom6e/mimo-v2.5');
  });

  it('normalizes stored model to bare id', () => {
    const account = customAccount({ model: 'custom-custom64/mimo-v2.5' });
    expect(normalizeStoredProviderModel(account)).toBe('mimo-v2.5');
  });

  it('normalizes bare model ids and full model refs to the same model id', () => {
    expect(extractModelIdFromModelRef('deepseek-v4-pro')).toBe('deepseek-v4-pro');
    expect(extractModelIdFromModelRef('custom-sub2g43efa837/deepseek-v4-pro')).toBe('deepseek-v4-pro');
  });
});

describe('findProviderItemByModelRef', () => {
  it('matches stale session ref against account with corrected runtime key', () => {
    const account = customAccount({ model: 'custom-custom64/mimo-v2.5' });
    const items = [{ account }];
    const match = findProviderItemByModelRef(items, 'custom-custom6e/mimo-v2.5');
    expect(match?.account.id).toBe('custom-custom6e');
  });
});
describe('resolveAccountModelRefs', () => {
  it('expands Sub2API runtime models into separate selectable refs', () => {
    const account = customAccount({
      id: 'sub2api-global-b3fe6919-apiKey-10',
      label: 'LY-MiniMax-M2.7',
      model: 'MiniMax-M2.7',
      fallbackModels: ['MiniMax-M2.7', 'deepseek-v4-pro'],
      runtimeModels: [
        { id: 'MiniMax-M2.7', name: 'LY-MiniMax-M2.7' },
        { id: 'deepseek-v4-pro', name: 'LY-deepseek-v4-pro' },
      ],
      metadata: { managedBy: 'sub2api', scope: 'global' },
    });

    expect(resolveAccountModelRefs(account)).toEqual([
      { modelId: 'MiniMax-M2.7', modelRef: 'custom-sub2g43efa837/MiniMax-M2.7', label: 'LY-MiniMax-M2.7' },
      { modelId: 'deepseek-v4-pro', modelRef: 'custom-sub2g43efa837/deepseek-v4-pro', label: 'LY-deepseek-v4-pro' },
    ]);
  });
});
