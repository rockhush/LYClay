import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderAccount } from '@electron/shared/providers/types';
import type { GlobalSub2ApiSubject } from '@electron/utils/sub2api-subject';

const mocks = vi.hoisted(() => ({
  listProviderAccounts: vi.fn(),
  saveProviderAccount: vi.fn(),
  deleteProviderAccount: vi.fn(),
  setProviderSecret: vi.fn(),
  deleteProviderSecret: vi.fn(),
  syncSavedProviderToRuntime: vi.fn(),
  syncDeletedProviderToRuntime: vi.fn(),
  setDefaultProvider: vi.fn(),
}));

vi.mock('@electron/services/providers/provider-store', () => ({
  listProviderAccounts: mocks.listProviderAccounts,
  saveProviderAccount: mocks.saveProviderAccount,
  deleteProviderAccount: mocks.deleteProviderAccount,
}));

vi.mock('@electron/services/secrets/secret-store', () => ({
  setProviderSecret: mocks.setProviderSecret,
  deleteProviderSecret: mocks.deleteProviderSecret,
}));

vi.mock('@electron/services/providers/provider-runtime-sync', () => ({
  syncSavedProviderToRuntime: mocks.syncSavedProviderToRuntime,
  syncDeletedProviderToRuntime: mocks.syncDeletedProviderToRuntime,
}));

vi.mock('@electron/utils/secure-storage', () => ({
  setDefaultProvider: mocks.setDefaultProvider,
}));

import {
  cleanupSub2ApiEmployeeSecret,
  reconcileGlobalSub2ApiProviders,
} from '../../electron/utils/openclaw-managed-models';

function account(overrides: Partial<ProviderAccount> = {}): ProviderAccount {
  return {
    id: 'custom-user',
    vendorId: 'custom',
    label: 'User Provider',
    authMode: 'api_key',
    baseUrl: 'https://user.example.com/v1',
    apiProtocol: 'openai-completions',
    model: 'user-model',
    enabled: true,
    isDefault: false,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

const subject: GlobalSub2ApiSubject = {
  scope: 'global',
  userNo: 'EMP001',
  source: 'dingtalk.jobNumber',
};

describe('OpenClaw managed Sub2API model reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listProviderAccounts.mockResolvedValue([]);
    mocks.saveProviderAccount.mockResolvedValue(undefined);
    mocks.deleteProviderAccount.mockResolvedValue(undefined);
    mocks.setProviderSecret.mockResolvedValue(undefined);
    mocks.deleteProviderSecret.mockResolvedValue(undefined);
    mocks.syncSavedProviderToRuntime.mockResolvedValue(undefined);
    mocks.syncDeletedProviderToRuntime.mockResolvedValue(undefined);
    mocks.setDefaultProvider.mockResolvedValue(undefined);
  });

  it('creates visible Sub2API managed provider accounts and secrets per credential', async () => {
    const result = await reconcileGlobalSub2ApiProviders(subject, [{
      credentialId: 'apiKey-10',
      apiKey: 'sk-test',
      baseUrl: 'https://sub2api.internal.example.com/v1',
      models: [{ modelId: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro' }],
    }], { now: '2026-07-06T10:00:00.000Z' });

    expect(result.status).toBe('updated');
    expect(result.providerIds).toEqual(['sub2api-global-b3fe6919-apiKey-10']);
    expect(mocks.saveProviderAccount).toHaveBeenCalledWith(expect.objectContaining({
      id: 'sub2api-global-b3fe6919-apiKey-10',
      vendorId: 'custom',
      label: 'LY-SUB2API',
      authMode: 'api_key',
      apiProtocol: 'openai-completions',
      baseUrl: 'https://sub2api.internal.example.com/v1',
      model: 'deepseek-v4-pro',
      fallbackModels: ['deepseek-v4-pro'],
      metadata: expect.objectContaining({
        managedBy: 'sub2api',
        scope: 'global',
        subjectHash: 'b3fe6919',
        hiddenInProviderSettings: false,
        lastSuccessAt: '2026-07-06T10:00:00.000Z',
      }),
    }));
    expect(mocks.setProviderSecret).toHaveBeenCalledWith({
      type: 'api_key',
      accountId: 'sub2api-global-b3fe6919-apiKey-10',
      apiKey: 'sk-test',
    });
    expect(mocks.setDefaultProvider).toHaveBeenCalledWith('sub2api-global-b3fe6919-apiKey-10');
    expect(mocks.syncSavedProviderToRuntime).toHaveBeenCalledTimes(1);
  });

  it('completes string Sub2API models with ly-auto default capabilities before runtime sync', async () => {
    await reconcileGlobalSub2ApiProviders(subject, [{
      credentialId: 'apiKey-10',
      apiKey: 'sk-test',
      baseUrl: 'https://sub2api.internal.example.com/v1',
      models: ['deepseek-v4-pro'],
    }], { now: '2026-07-06T10:00:00.000Z' });

    expect(mocks.syncSavedProviderToRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeModels: [expect.objectContaining({
          id: 'deepseek-v4-pro',
          name: 'LY-deepseek-v4-pro',
          input: ['text', 'image'],
          contextWindow: 200000,
          contextTokens: 200000,
          maxTokens: 16384,
          timeoutSeconds: 900,
          reasoning: true,
          compat: expect.objectContaining({
            supportsPromptCacheKey: true,
            thinkingFormat: 'qwen-chat-template',
          }),
        })],
      }),
      'sk-test',
      undefined,
    );
  });
  it('passes LY-prefixed provider/model names and completed model capabilities to runtime sync', async () => {
    await reconcileGlobalSub2ApiProviders(subject, [{
      credentialId: 'apiKey-10',
      apiKey: 'sk-test',
      baseUrl: 'https://sub2api.internal.example.com/v1',
      models: [{
        modelId: 'MiniMax-M2.7',
        input: ['text', 'image'],
        contextWindow: 200000,
        contextTokens: 200000,
        maxTokens: 16384,
        timeoutSeconds: 900,
        reasoning: true,
      }],
    }], { now: '2026-07-06T10:00:00.000Z' });

    expect(mocks.syncSavedProviderToRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'LY-SUB2API',
        runtimeModels: [expect.objectContaining({
          id: 'MiniMax-M2.7',
          name: 'LY-MiniMax-M2.7',
          input: ['text', 'image'],
          contextWindow: 200000,
          contextTokens: 200000,
          maxTokens: 16384,
          timeoutSeconds: 900,
          reasoning: true,
        })],
      }),
      'sk-test',
      undefined,
    );
  });
  it('deletes stale managed providers for the same subject without touching user providers', async () => {
    mocks.listProviderAccounts.mockResolvedValue([
      account(),
      account({
        id: 'sub2api-global-b3fe6919-old',
        label: 'Old Sub2API',
        metadata: { managedBy: 'sub2api', scope: 'global', subjectHash: 'b3fe6919' },
      } as Partial<ProviderAccount>),
      account({
        id: 'sub2api-global-other-keep',
        label: 'Other Subject',
        metadata: { managedBy: 'sub2api', scope: 'global', subjectHash: 'other' },
      } as Partial<ProviderAccount>),
    ]);

    await reconcileGlobalSub2ApiProviders(subject, [{
      credentialId: 'apiKey-10',
      apiKey: 'sk-test',
      baseUrl: 'https://sub2api.internal.example.com/v1',
      models: ['deepseek-v4-pro'],
    }], { now: '2026-07-06T10:00:00.000Z' });

    expect(mocks.deleteProviderAccount).toHaveBeenCalledWith('sub2api-global-b3fe6919-old');
    expect(mocks.deleteProviderSecret).toHaveBeenCalledWith('sub2api-global-b3fe6919-old');
    expect(mocks.deleteProviderAccount).not.toHaveBeenCalledWith('custom-user');
    expect(mocks.deleteProviderAccount).not.toHaveBeenCalledWith('sub2api-global-other-keep');
  });

  it('replaces the managed model set on each successful pull', async () => {
    await reconcileGlobalSub2ApiProviders(subject, [{
      credentialId: 'apiKey-10',
      apiKey: 'sk-test',
      baseUrl: 'https://sub2api.internal.example.com/v1',
      models: ['a-model'],
    }], { now: '2026-07-06T10:00:00.000Z' });

    await reconcileGlobalSub2ApiProviders(subject, [{
      credentialId: 'apiKey-10',
      apiKey: 'sk-test',
      baseUrl: 'https://sub2api.internal.example.com/v1',
      models: ['a-model', 'b-model'],
    }], { now: '2026-07-06T10:01:00.000Z' });

    await reconcileGlobalSub2ApiProviders(subject, [{
      credentialId: 'apiKey-10',
      apiKey: 'sk-test',
      baseUrl: 'https://sub2api.internal.example.com/v1',
      models: ['b-model', 'c-model'],
    }], { now: '2026-07-06T10:02:00.000Z' });

    expect(mocks.saveProviderAccount).toHaveBeenLastCalledWith(expect.objectContaining({
      model: 'b-model',
      fallbackModels: ['b-model', 'c-model'],
      runtimeModels: [
        expect.objectContaining({ id: 'b-model', name: 'LY-b-model' }),
        expect.objectContaining({ id: 'c-model', name: 'LY-c-model' }),
      ],
    }));
  });

  it('deletes stale managed providers when credentials have no models', async () => {
    mocks.listProviderAccounts.mockResolvedValue([
      account({
        id: 'sub2api-global-b3fe6919-old',
        metadata: { managedBy: 'sub2api', scope: 'global', subjectHash: 'b3fe6919' },
      } as Partial<ProviderAccount>),
    ]);

    const result = await reconcileGlobalSub2ApiProviders(subject, [{
      credentialId: 'apiKey-10',
      apiKey: 'sk-test',
      baseUrl: 'https://sub2api.internal.example.com/v1',
      models: [],
    }]);

    expect(result.status).toBe('cleared-empty-models');
    expect(mocks.saveProviderAccount).not.toHaveBeenCalled();
    expect(mocks.deleteProviderAccount).toHaveBeenCalledWith('sub2api-global-b3fe6919-old');
    expect(mocks.deleteProviderSecret).toHaveBeenCalledWith('sub2api-global-b3fe6919-old');
  });

  it('deletes employee scoped secret by provider id', async () => {
    await cleanupSub2ApiEmployeeSecret('sub2api-employee-document-1');

    expect(mocks.deleteProviderSecret).toHaveBeenCalledWith('sub2api-employee-document-1');
  });
});

