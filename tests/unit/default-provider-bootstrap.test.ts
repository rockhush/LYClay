import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getProviderDefinition: vi.fn(),
  readOpenClawConfig: vi.fn(),
  writeOpenClawConfig: vi.fn(),
  syncProviderConfigToOpenClaw: vi.fn(),
  updateAgentModelProvider: vi.fn(),
  getOpenClawProviderKeyForType: vi.fn(),
  getAccount: vi.fn(),
  getDefaultAccountId: vi.fn(),
  setDefaultAccount: vi.fn(),
  storeApiKey: vi.fn(),
  saveProviderAccount: vi.fn(),
  getProviderAccount: vi.fn(),
  deleteProvider: vi.fn(),
  removeProviderFromOpenClaw: vi.fn(),
  proxyAwareFetch: vi.fn(),
  syncDefaultProviderToRuntime: vi.fn(),
}));

vi.mock('@electron/shared/providers/registry', () => ({
  getProviderDefinition: mocks.getProviderDefinition,
}));

vi.mock('@electron/utils/channel-config', () => ({
  readOpenClawConfig: mocks.readOpenClawConfig,
  writeOpenClawConfig: mocks.writeOpenClawConfig,
}));

vi.mock('@electron/utils/config-mutex', () => ({
  withConfigLock: (fn: () => Promise<unknown>) => fn(),
}));

vi.mock('@electron/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@electron/utils/openclaw-auth', () => ({
  removeProviderFromOpenClaw: mocks.removeProviderFromOpenClaw,
  syncProviderConfigToOpenClaw: mocks.syncProviderConfigToOpenClaw,
  updateAgentModelProvider: mocks.updateAgentModelProvider,
}));

vi.mock('@electron/utils/provider-keys', () => ({
  getOpenClawProviderKeyForType: mocks.getOpenClawProviderKeyForType,
}));

vi.mock('@electron/services/providers/provider-service', () => ({
  getProviderService: () => ({
    getAccount: mocks.getAccount,
    getDefaultAccountId: mocks.getDefaultAccountId,
    setDefaultAccount: mocks.setDefaultAccount,
  }),
}));

vi.mock('@electron/utils/secure-storage', () => ({
  deleteProvider: mocks.deleteProvider,
  storeApiKey: mocks.storeApiKey,
}));

vi.mock('@electron/utils/proxy-fetch', () => ({
  proxyAwareFetch: (...args: unknown[]) => mocks.proxyAwareFetch(...args),
}));

vi.mock('@electron/services/providers/provider-store', () => ({
  getProviderAccount: mocks.getProviderAccount,
  saveProviderAccount: mocks.saveProviderAccount,
}));

vi.mock('@electron/services/providers/provider-runtime-sync', () => ({
  syncDefaultProviderToRuntime: mocks.syncDefaultProviderToRuntime,
}));

import { bootstrapLyManagedProviders } from '@electron/services/providers/default-provider-bootstrap';

describe('bootstrapLyManagedProviders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.proxyAwareFetch.mockRejectedValue(new Error('network unavailable in unit test'));
    mocks.getProviderDefinition.mockReturnValue({ defaultModelId: 'auto' });
    mocks.readOpenClawConfig.mockResolvedValue({ models: { providers: {} }, agents: { defaults: { model: {} } } });
    mocks.writeOpenClawConfig.mockResolvedValue(undefined);
    mocks.syncProviderConfigToOpenClaw.mockResolvedValue(undefined);
    mocks.updateAgentModelProvider.mockResolvedValue(undefined);
    mocks.getOpenClawProviderKeyForType.mockImplementation((type: string) => type);
    mocks.getAccount.mockResolvedValue(null);
    mocks.getDefaultAccountId.mockResolvedValue('existing-default');
    mocks.setDefaultAccount.mockResolvedValue(undefined);
    mocks.getProviderAccount.mockResolvedValue(null);
    mocks.deleteProvider.mockResolvedValue(true);
    mocks.removeProviderFromOpenClaw.mockResolvedValue(undefined);
    mocks.storeApiKey.mockResolvedValue(true);
    mocks.saveProviderAccount.mockResolvedValue(undefined);
    mocks.syncDefaultProviderToRuntime.mockResolvedValue(undefined);
  });

  it('registers only ly-auto as the LY-managed provider', async () => {
    await bootstrapLyManagedProviders();

    expect(mocks.saveProviderAccount).toHaveBeenCalledWith(expect.objectContaining({
      id: 'ly-auto',
      vendorId: 'ly-auto',
      label: 'LY-Auto',
      authMode: 'api_key',
      baseUrl: 'http://10.64.10.48/v1',
      apiProtocol: 'openai-completions',
      model: 'auto',
      metadata: expect.objectContaining({ managedBy: 'lyclaw', readonly: true }),
    }));

    expect(mocks.storeApiKey).toHaveBeenCalledWith('ly-auto', 'EMPTY');

    // Should remove old LY providers
    expect(mocks.deleteProvider).toHaveBeenCalledWith('ly-minimax');
    expect(mocks.deleteProvider).toHaveBeenCalledWith('ly-deepseek');
    expect(mocks.deleteProvider).toHaveBeenCalledWith('ly-qwen');
    expect(mocks.deleteProvider).toHaveBeenCalledWith('ly-mimo');

    expect(mocks.proxyAwareFetch).toHaveBeenCalled();

    // Should sync only ly-auto (fallback overrides when nginx fetch fails in unit tests)
    expect(mocks.syncProviderConfigToOpenClaw).toHaveBeenCalledWith(
      'ly-auto',
      'auto',
      expect.objectContaining({
        baseUrl: 'http://10.64.10.48/v1',
        api: 'openai-completions',
        modelOverrides: {
          auto: expect.objectContaining({
            input: ['text', 'image'],
            compat: expect.objectContaining({
              supportsUsageInStreaming: true,
              supportsPromptCacheKey: false,
            }),
          }),
        },
      }),
    );

    expect(mocks.updateAgentModelProvider).toHaveBeenCalledWith(
      'ly-auto',
      expect.objectContaining({
        baseUrl: 'http://10.64.10.48/v1',
        api: 'openai-completions',
        apiKey: 'EMPTY',
        models: [expect.objectContaining({
          id: 'auto',
          input: ['text', 'image'],
          compat: expect.objectContaining({ supportsUsageInStreaming: true }),
        })],
      }),
    );

    // Should not create old providers
    expect(mocks.saveProviderAccount).not.toHaveBeenCalledWith(expect.objectContaining({ vendorId: 'ly-minimax' }));
    expect(mocks.saveProviderAccount).not.toHaveBeenCalledWith(expect.objectContaining({ vendorId: 'ly-deepseek' }));
    expect(mocks.saveProviderAccount).not.toHaveBeenCalledWith(expect.objectContaining({ vendorId: 'ly-qwen' }));
  });

  it('keeps an existing non-ly-auto default provider instead of resetting agents to auto', async () => {
    mocks.getDefaultAccountId.mockResolvedValue('modelstudio-default');

    await bootstrapLyManagedProviders();

    expect(mocks.setDefaultAccount).not.toHaveBeenCalledWith('ly-auto');
    expect(mocks.syncDefaultProviderToRuntime).toHaveBeenCalledWith('modelstudio-default', undefined);
    const writes = mocks.writeOpenClawConfig.mock.calls.map((call) => call[0]);
    expect(writes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        agents: expect.objectContaining({
          defaults: expect.objectContaining({
            model: expect.objectContaining({ primary: 'ly-auto/auto' }),
          }),
        }),
      }),
    ]));
  });
});
