import { describe, expect, it } from 'vitest';
import { buildProviderListItems } from '@/lib/provider-accounts';
import type { ProviderAccount } from '@/lib/providers';

function account(overrides: Partial<ProviderAccount> = {}): ProviderAccount {
  return {
    id: 'custom-user',
    vendorId: 'custom',
    label: 'User Provider',
    authMode: 'api_key',
    enabled: true,
    isDefault: false,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('provider account list items', () => {
  it('keeps visible Sub2API managed accounts in provider settings lists', () => {
    const items = buildProviderListItems([
      account(),
      account({
        id: 'sub2api-global-b3fe6919-apiKey-10',
        label: 'LY-SUB2API',
        metadata: {
          managedBy: 'sub2api',
          hiddenInProviderSettings: false,
        },
      }),
    ], [], [], null);

    expect(items.map((item) => item.account.id)).toEqual(expect.arrayContaining([
      'sub2api-global-b3fe6919-apiKey-10',
      'custom-user',
    ]));
  });

  it('filters employee-scoped hidden Sub2API accounts from provider settings lists', () => {
    const items = buildProviderListItems([
      account(),
      account({
        id: 'sub2api-employee-document-analyst-a1b2c3d4',
        label: 'LY-SUB2API',
        metadata: {
          managedBy: 'sub2api',
          scope: 'digitalEmployee',
          hiddenInProviderSettings: true,
        },
      }),
    ], [], [], null);

    expect(items.map((item) => item.account.id)).toEqual(['custom-user']);
  });
});