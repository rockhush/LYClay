import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getProviderDefinition: vi.fn(),
  readOpenClawConfig: vi.fn(),
  writeOpenClawConfig: vi.fn(),
  syncProviderConfigToOpenClaw: vi.fn(),
  updateAgentModelProvider: vi.fn(),
  getOpenClawProviderKeyForType: vi.fn(),
  listConfiguredAgentIds: vi.fn(),
  getOpenClawConfigDir: vi.fn(),
  getAccount: vi.fn(),
  getDefaultProvider: vi.fn(),
  setDefaultProvider: vi.fn(),
  storeApiKey: vi.fn(),
  saveProviderAccount: vi.fn(),
  getProviderAccount: vi.fn(),
  deleteProviderAccount: vi.fn(),
}));

vi.mock('@electron/shared/providers/registry', () => ({
  getProviderDefinition: mocks.getProviderDefinition,
}));

vi.mock('@electron/utils/agent-config', () => ({
  listConfiguredAgentIds: mocks.listConfiguredAgentIds,
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
  syncProviderConfigToOpenClaw: mocks.syncProviderConfigToOpenClaw,
  updateAgentModelProvider: mocks.updateAgentModelProvider,
}));

vi.mock('@electron/utils/paths', () => ({
  getOpenClawConfigDir: mocks.getOpenClawConfigDir,
}));

vi.mock('@electron/utils/provider-keys', () => ({
  getOpenClawProviderKeyForType: mocks.getOpenClawProviderKeyForType,
}));

vi.mock('@electron/services/providers/provider-service', () => ({
  getProviderService: () => ({
    getAccount: mocks.getAccount,
  }),
}));

vi.mock('@electron/utils/secure-storage', () => ({
  getDefaultProvider: mocks.getDefaultProvider,
  setDefaultProvider: mocks.setDefaultProvider,
  storeApiKey: mocks.storeApiKey,
}));

vi.mock('@electron/services/providers/provider-store', () => ({
  deleteProviderAccount: mocks.deleteProviderAccount,
  getProviderAccount: mocks.getProviderAccount,
  saveProviderAccount: mocks.saveProviderAccount,
}));

import { bootstrapLyManagedProviders } from '@electron/services/providers/default-provider-bootstrap';

describe('bootstrapLyManagedProviders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderDefinition.mockReturnValue({ defaultModelId: 'MiniMax-M2.7' });
    mocks.readOpenClawConfig.mockResolvedValue({ models: { providers: {} }, agents: { defaults: { model: {} } } });
    mocks.writeOpenClawConfig.mockResolvedValue(undefined);
    mocks.syncProviderConfigToOpenClaw.mockResolvedValue(undefined);
    mocks.updateAgentModelProvider.mockResolvedValue(undefined);
    mocks.getOpenClawProviderKeyForType.mockImplementation((type: string) => type);
    mocks.listConfiguredAgentIds.mockResolvedValue([]);
    mocks.getOpenClawConfigDir.mockReturnValue('C:/tmp/openclaw');
    mocks.getAccount.mockResolvedValue(null);
    mocks.getProviderAccount.mockResolvedValue(null);
    mocks.deleteProviderAccount.mockResolvedValue(undefined);
    mocks.getDefaultProvider.mockResolvedValue('existing-default');
    mocks.setDefaultProvider.mockResolvedValue(undefined);
    mocks.storeApiKey.mockResolvedValue(true);
    mocks.saveProviderAccount.mockResolvedValue(undefined);
  });

  it('pre-registers LY-MiniMax and LY-Mimo as managed runtime providers', async () => {
    await bootstrapLyManagedProviders();

    expect(mocks.saveProviderAccount).toHaveBeenCalledWith(expect.objectContaining({
      id: 'ly-minimax',
      vendorId: 'ly-minimax',
      label: 'LY-MiniMax',
      authMode: 'api_key',
      baseUrl: 'http://10.64.22.11:8000/v1',
      apiProtocol: 'anthropic-messages',
      model: 'MiniMax-M2.7',
      metadata: expect.objectContaining({ managedBy: 'lyclaw', readonly: true }),
    }));
    expect(mocks.saveProviderAccount).toHaveBeenCalledWith(expect.objectContaining({
      id: 'ly-mimo',
      vendorId: 'ly-mimo',
      label: 'LY-Mimo',
      authMode: 'api_key',
      baseUrl: 'http://10.64.22.12:8000/v1',
      apiProtocol: 'anthropic-messages',
      model: 'MiMo-V2.5',
      metadata: expect.objectContaining({ managedBy: 'lyclaw', readonly: true }),
    }));

    expect(mocks.storeApiKey).toHaveBeenCalledWith('ly-minimax', 'EMPTY');
    expect(mocks.storeApiKey).toHaveBeenCalledWith('ly-mimo', 'EMPTY');
    expect(mocks.syncProviderConfigToOpenClaw).toHaveBeenCalledWith(
      'ly-minimax',
      'MiniMax-M2.7',
      expect.objectContaining({
        baseUrl: 'http://10.64.22.11:8000/v1',
        api: 'anthropic-messages',
        apiKeyEnv: 'LY_MINIMAX_API_KEY',
        modelOverrides: {
          'MiniMax-M2.7': { maxTokens: 98304 },
        },
      }),
    );
    expect(mocks.syncProviderConfigToOpenClaw).toHaveBeenCalledWith(
      'ly-mimo',
      'MiMo-V2.5',
      expect.objectContaining({
        baseUrl: 'http://10.64.22.12:8000/v1',
        api: 'anthropic-messages',
        apiKeyEnv: 'LY_MIMO_API_KEY',
        modelOverrides: {
          'MiMo-V2.5': { input: ['text', 'image'], maxTokens: 98304 },
        },
      }),
    );
    expect(mocks.updateAgentModelProvider).toHaveBeenCalledWith(
      'ly-minimax',
      expect.objectContaining({
        baseUrl: 'http://10.64.22.11:8000/anthropic',
        api: 'anthropic-messages',
        apiKey: 'EMPTY',
        models: [expect.objectContaining({ id: 'MiniMax-M2.7', maxTokens: 98304 })],
      }),
    );
    expect(mocks.updateAgentModelProvider).toHaveBeenCalledWith(
      'ly-mimo',
      expect.objectContaining({
        baseUrl: 'http://10.64.22.12:8000/anthropic',
        api: 'anthropic-messages',
        apiKey: 'EMPTY',
        models: [expect.objectContaining({ id: 'MiMo-V2.5', input: ['text', 'image'], maxTokens: 98304 })],
      }),
    );
  });
});
