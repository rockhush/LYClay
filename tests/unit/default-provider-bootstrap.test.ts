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
  getDefaultAccountId: vi.fn(),
  setDefaultAccount: vi.fn(),
  getDefaultProvider: vi.fn(),
  setDefaultProvider: vi.fn(),
  storeApiKey: vi.fn(),
  saveProviderAccount: vi.fn(),
  getProviderAccount: vi.fn(),
  deleteProviderAccount: vi.fn(),
  deleteProvider: vi.fn(),
  removeProviderFromOpenClaw: vi.fn(),
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
  removeProviderFromOpenClaw: mocks.removeProviderFromOpenClaw,
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
    getDefaultAccountId: mocks.getDefaultAccountId,
    setDefaultAccount: mocks.setDefaultAccount,
  }),
}));

vi.mock('@electron/utils/secure-storage', () => ({
  deleteProvider: mocks.deleteProvider,
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
    mocks.getDefaultAccountId.mockResolvedValue('existing-default');
    mocks.setDefaultAccount.mockResolvedValue(undefined);
    mocks.getProviderAccount.mockResolvedValue(null);
    mocks.deleteProvider.mockResolvedValue(true);
    mocks.removeProviderFromOpenClaw.mockResolvedValue(undefined);
    mocks.getDefaultProvider.mockResolvedValue('existing-default');
    mocks.setDefaultProvider.mockResolvedValue(undefined);
    mocks.storeApiKey.mockResolvedValue(true);
    mocks.saveProviderAccount.mockResolvedValue(undefined);
  });

  it('pre-registers LY-managed providers and removes retired LY-Mimo', async () => {
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
    expect(mocks.deleteProvider).toHaveBeenCalledWith('ly-mimo');
    expect(mocks.removeProviderFromOpenClaw).toHaveBeenCalledWith('ly-mimo');
    expect(mocks.storeApiKey).toHaveBeenCalledWith('ly-minimax', 'EMPTY');
    expect(mocks.storeApiKey).not.toHaveBeenCalledWith('ly-mimo', expect.anything());
    expect(mocks.syncProviderConfigToOpenClaw).toHaveBeenCalledWith(
      'ly-minimax',
      'MiniMax-M2.7',
      expect.objectContaining({
        baseUrl: 'http://10.64.22.11:8000/v1',
        api: 'anthropic-messages',
        apiKeyEnv: 'LY_MINIMAX_API_KEY',
        modelOverrides: {
          'MiniMax-M2.7': {
            input: ['text'],
            contextWindow: 204800,
            maxTokens: 60000,
          },
        },
      }),
    );
    expect(mocks.updateAgentModelProvider).toHaveBeenCalledWith(
      'ly-minimax',
      expect.objectContaining({
        baseUrl: 'http://10.64.22.11:8000/anthropic',
        api: 'anthropic-messages',
        apiKey: 'EMPTY',
        models: [expect.objectContaining({ id: 'MiniMax-M2.7', contextWindow: 204800, maxTokens: 60000 })],
      }),
    );
    expect(mocks.saveProviderAccount).toHaveBeenCalledWith(expect.objectContaining({
      id: 'ly-qwen',
      vendorId: 'ly-qwen',
      label: 'LY-Qwen',
      authMode: 'api_key',
      baseUrl: 'http://10.64.22.12:8000/v1',
      apiProtocol: 'openai-completions',
      model: 'qwen3.5-397b',
      metadata: expect.objectContaining({ managedBy: 'lyclaw' }),
    }));
    expect(mocks.storeApiKey).toHaveBeenCalledWith('ly-qwen', 'EMPTY');
    expect(mocks.syncProviderConfigToOpenClaw).toHaveBeenCalledWith(
      'ly-qwen',
      'qwen3.5-397b',
      expect.objectContaining({
        baseUrl: 'http://10.64.22.12:8000/v1',
        api: 'openai-completions',
        apiKeyEnv: 'LY_QWEN_API_KEY',
        modelOverrides: {
          'qwen3.5-397b': {
            reasoning: true,
            input: ['text', 'image'],
            contextWindow: 130000,
            maxTokens: 81920,
          },
        },
      }),
    );
    expect(mocks.updateAgentModelProvider).toHaveBeenCalledWith(
      'ly-qwen',
      expect.objectContaining({
        baseUrl: 'http://10.64.22.12:8000/v1',
        api: 'openai-completions',
        apiKey: 'EMPTY',
        models: [expect.objectContaining({
          id: 'qwen3.5-397b',
          reasoning: true,
          input: ['text', 'image'],
          contextWindow: 130000,
          maxTokens: 81920,
        })],
      }),
    );
  });
});
