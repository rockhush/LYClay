import { describe, expect, it } from 'vitest';
import { getOpenClawProviderKeyForType } from '@electron/utils/provider-keys';
import { resolveRuntimeProviderKey } from '@/lib/provider-model-ref';
import type { ProviderAccount } from '@/lib/providers';

describe('getOpenClawProviderKeyForType', () => {
  it('maps short custom account ids to custom-{suffix}', () => {
    expect(getOpenClawProviderKeyForType('custom', 'customb5')).toBe('custom-customb5');
    expect(getOpenClawProviderKeyForType('custom', 'customa6')).toBe('custom-customa6');
  });

  it('preserves openclaw-seeded runtime keys with non-8-char suffixes', () => {
    expect(getOpenClawProviderKeyForType('custom', 'custom-customb5')).toBe('custom-customb5');
  });

  it('preserves 8-char hashed runtime keys', () => {
    expect(getOpenClawProviderKeyForType('custom', 'custom-abcdefgh')).toBe('custom-abcdefgh');
  });

  it('uses scope-aware stable keys for Sub2API managed custom providers', () => {
    expect(getOpenClawProviderKeyForType('custom', 'sub2api-employee-employee-document-1')).toBe('custom-sub2ed291be5b');
    expect(getOpenClawProviderKeyForType('custom', 'sub2api-global-b3fe6919-apiKey-10')).toBe('custom-sub2g43efa837');
    expect(getOpenClawProviderKeyForType('custom', 'sub2api-employee-employee-document-1'))
      .not.toBe(getOpenClawProviderKeyForType('custom', 'sub2api-global-b3fe6919-apiKey-10'));
  });

  it('aliases minimax portal cn to minimax-portal', () => {
    expect(getOpenClawProviderKeyForType('minimax-portal-cn', 'default')).toBe('minimax-portal');
  });
});

describe('resolveRuntimeProviderKey', () => {
  it('matches openclaw-seeded custom provider account ids', () => {
    const account: ProviderAccount = {
      id: 'custom-customb5',
      vendorId: 'custom',
      label: 'DeepSeek',
      authMode: 'api_key',
      model: 'deepseek-v4-pro',
      enabled: true,
      isDefault: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    expect(resolveRuntimeProviderKey(account)).toBe('custom-customb5');
  });
});
