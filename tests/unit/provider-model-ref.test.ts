import { describe, expect, it } from 'vitest';
import type { ProviderAccount } from '../../src/lib/providers';
import {
  findProviderItemByModelRef,
  normalizeStoredProviderModel,
  resolveAccountModelRef,
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
});

describe('findProviderItemByModelRef', () => {
  it('matches stale session ref against account with corrected runtime key', () => {
    const account = customAccount({ model: 'custom-custom64/mimo-v2.5' });
    const items = [{ account }];
    const match = findProviderItemByModelRef(items, 'custom-custom6e/mimo-v2.5');
    expect(match?.account.id).toBe('custom-custom6e');
  });
});
