import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GatewayManager } from '@electron/gateway/manager';
import type { ProviderConfig } from '@electron/utils/secure-storage';

const mocks = vi.hoisted(() => ({
  getProviderAccount: vi.fn(),
  listProviderAccounts: vi.fn(),
  getProviderSecret: vi.fn(),
  getAllProviders: vi.fn(),
  getApiKey: vi.fn(),
  getDefaultProvider: vi.fn(),
  getProvider: vi.fn(),
  getProviderConfig: vi.fn(),
  getProviderDefaultModel: vi.fn(),
  removeProviderFromOpenClaw: vi.fn(),
  removeProviderKeyFromOpenClaw: vi.fn(),
  saveOAuthTokenToOpenClaw: vi.fn(),
  saveProviderKeyToOpenClaw: vi.fn(),
  setOpenClawDefaultModel: vi.fn(),
  setOpenClawDefaultModelWithOverride: vi.fn(),
  syncProviderConfigToOpenClaw: vi.fn(),
  updateAgentModelProvider: vi.fn(),
  updateSingleAgentModelProvider: vi.fn(),
  listAgentsSnapshot: vi.fn(),
  resetAgentModelsForProvider: vi.fn(),
  updateAgentModel: vi.fn(),
}));

vi.mock('@electron/services/providers/provider-store', () => ({
  getProviderAccount: mocks.getProviderAccount,
  listProviderAccounts: mocks.listProviderAccounts,
}));

vi.mock('@electron/services/secrets/secret-store', () => ({
  getProviderSecret: mocks.getProviderSecret,
}));

vi.mock('@electron/utils/secure-storage', () => ({
  getAllProviders: mocks.getAllProviders,
  getApiKey: mocks.getApiKey,
  getDefaultProvider: mocks.getDefaultProvider,
  getProvider: mocks.getProvider,
}));

vi.mock('@electron/utils/provider-registry', () => ({
  LY_AUTO_PROVIDER_ID: 'ly-auto',
  getProviderConfig: mocks.getProviderConfig,
  getProviderDefaultModel: mocks.getProviderDefaultModel,
}));

vi.mock('@electron/utils/openclaw-auth', () => ({
  ensureAgentContextTokensCapForLargeModels: vi.fn(async () => false),
  ensureAgentModelsJsonValid: vi.fn(async () => false),
  ensureModelCatalogContextTokensForLargeModels: vi.fn(async () => false),
  removeProviderFromOpenClaw: mocks.removeProviderFromOpenClaw,
  removeProviderKeyFromOpenClaw: mocks.removeProviderKeyFromOpenClaw,
  saveOAuthTokenToOpenClaw: mocks.saveOAuthTokenToOpenClaw,
  saveProviderKeyToOpenClaw: mocks.saveProviderKeyToOpenClaw,
  setOpenClawDefaultModel: mocks.setOpenClawDefaultModel,
  setOpenClawDefaultModelWithOverride: mocks.setOpenClawDefaultModelWithOverride,
  syncProviderConfigToOpenClaw: mocks.syncProviderConfigToOpenClaw,
  updateAgentModelProvider: mocks.updateAgentModelProvider,
  updateSingleAgentModelProvider: mocks.updateSingleAgentModelProvider,
}));

vi.mock('@electron/utils/agent-config', () => ({
  listAgentsSnapshot: mocks.listAgentsSnapshot,
  resetAgentModelsForProvider: mocks.resetAgentModelsForProvider,
  updateAgentModel: mocks.updateAgentModel,
}));

vi.mock('@electron/utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  getOpenClawProviderKey,
  syncAgentModelOverrideToRuntime,
  syncDefaultProviderToRuntime,
  syncDeletedProviderApiKeyToRuntime,
  syncDeletedProviderToRuntime,
  syncSavedProviderToRuntime,
  syncUpdatedProviderToRuntime,
} from '@electron/services/providers/provider-runtime-sync';

function createProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'moonshot',
    name: 'Moonshot',
    type: 'moonshot',
    model: 'kimi-k2.6',
    enabled: true,
    createdAt: '2026-03-14T00:00:00.000Z',
    updatedAt: '2026-03-14T00:00:00.000Z',
    ...overrides,
  };
}

function createGateway(state: 'running' | 'stopped' = 'running'): Pick<GatewayManager, 'debouncedReload' | 'debouncedRestart' | 'getStatus' | 'isConnected' | 'rpc'> {
  return {
    debouncedReload: vi.fn(),
    debouncedRestart: vi.fn(),
    getStatus: vi.fn(() => ({ state } as ReturnType<GatewayManager['getStatus']>)),
    isConnected: vi.fn(() => state === 'running'),
    rpc: vi.fn().mockResolvedValue(undefined),
  };
}

describe('provider-runtime-sync refresh strategy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderAccount.mockResolvedValue(null);
    mocks.getProviderSecret.mockResolvedValue(undefined);
    mocks.getAllProviders.mockResolvedValue([]);
    mocks.getApiKey.mockResolvedValue('sk-test');
    mocks.getDefaultProvider.mockResolvedValue('moonshot');
    mocks.getProvider.mockResolvedValue(createProvider());
    mocks.getProviderDefaultModel.mockReturnValue('kimi-k2.6');
    mocks.getProviderConfig.mockReturnValue({
      api: 'openai-completions',
      baseUrl: 'https://api.moonshot.cn/v1',
      apiKeyEnv: 'MOONSHOT_API_KEY',
    });
    mocks.syncProviderConfigToOpenClaw.mockResolvedValue(undefined);
    mocks.setOpenClawDefaultModel.mockResolvedValue(undefined);
    mocks.setOpenClawDefaultModelWithOverride.mockResolvedValue(undefined);
    mocks.saveProviderKeyToOpenClaw.mockResolvedValue(undefined);
    mocks.removeProviderFromOpenClaw.mockResolvedValue(undefined);
    mocks.removeProviderKeyFromOpenClaw.mockResolvedValue(undefined);
    mocks.updateAgentModelProvider.mockResolvedValue(undefined);
    mocks.updateSingleAgentModelProvider.mockResolvedValue(undefined);
    mocks.resetAgentModelsForProvider.mockResolvedValue(undefined);
    mocks.updateAgentModel.mockResolvedValue(undefined);
    mocks.listAgentsSnapshot.mockResolvedValue({ agents: [] });
  });

  it('hot-updates after saving the default provider config', async () => {
    const gateway = createGateway('running');
    await syncSavedProviderToRuntime(createProvider(), undefined, gateway as GatewayManager);

    expect(gateway.rpc).toHaveBeenCalledWith('agents.update', {
      agentId: 'main',
      model: 'moonshot/kimi-k2.6',
    }, 10000);
    expect(gateway.debouncedReload).not.toHaveBeenCalled();
    expect(gateway.debouncedRestart).not.toHaveBeenCalled();
  });

  it('uses debouncedRestart after deleting provider config', async () => {
    const gateway = createGateway('running');
    await syncDeletedProviderToRuntime(createProvider(), 'moonshot', gateway as GatewayManager);

    expect(gateway.debouncedRestart).toHaveBeenCalledTimes(1);
    expect(gateway.debouncedReload).not.toHaveBeenCalled();
  });

  it('removes both runtime and stored account keys when deleting a custom provider', async () => {
    const gateway = createGateway('running');
    const customProvider = createProvider({
      id: 'moonshot-cn',
      type: 'custom',
      baseUrl: 'https://api.moonshot.cn/v1',
    });

    await syncDeletedProviderToRuntime(customProvider, 'moonshot-cn', gateway as GatewayManager);

    expect(mocks.removeProviderFromOpenClaw).toHaveBeenCalledWith('custom-moonshot');
    expect(mocks.removeProviderFromOpenClaw).toHaveBeenCalledWith('moonshot-cn');
    expect(mocks.removeProviderFromOpenClaw).toHaveBeenCalledTimes(2);
    expect(gateway.debouncedRestart).toHaveBeenCalledTimes(1);
  });

  it('only clears the api-key profile when deleting a provider api key', async () => {
    const openaiProvider = createProvider({
      id: 'openai-personal',
      type: 'openai',
    });

    await syncDeletedProviderApiKeyToRuntime(openaiProvider, 'openai-personal');

    expect(mocks.removeProviderKeyFromOpenClaw).toHaveBeenCalledWith('openai');
    expect(mocks.removeProviderFromOpenClaw).not.toHaveBeenCalled();
  });

  it('hot-updates after switching default provider when gateway is running', async () => {
    const gateway = createGateway('running');
    await syncDefaultProviderToRuntime('moonshot', gateway as GatewayManager);

    expect(mocks.updateAgentModel).toHaveBeenCalledWith('main', 'moonshot/kimi-k2.6');
    expect(gateway.rpc).toHaveBeenCalledWith('agents.update', {
      agentId: 'main',
      model: 'moonshot/kimi-k2.6',
    }, 10000);
    expect(gateway.debouncedReload).not.toHaveBeenCalled();
    expect(gateway.debouncedRestart).not.toHaveBeenCalled();
  });

  it('skips refresh after switching default provider when gateway is stopped', async () => {
    const gateway = createGateway('stopped');
    await syncDefaultProviderToRuntime('moonshot', gateway as GatewayManager);

    expect(mocks.updateAgentModel).toHaveBeenCalledWith('main', 'moonshot/kimi-k2.6');
    expect(gateway.debouncedReload).not.toHaveBeenCalled();
    expect(gateway.debouncedRestart).not.toHaveBeenCalled();
  });

  it('syncs every agent model when DeepSeek becomes the default provider', async () => {
    mocks.getProvider.mockResolvedValue(createProvider({
      id: 'ly-deepseek-default',
      type: 'deepseek',
      model: 'deepseek-v4-flash',
    }));
    mocks.listAgentsSnapshot.mockResolvedValue({
      agents: [
        { id: 'main', modelRef: 'moonshot/kimi-k2.6' },
        { id: 'research', modelRef: 'openrouter/anthropic/claude-opus-4.6' },
        { id: 'dingtalk', modelRef: 'ly-auto/auto' },
      ],
    });
    mocks.getProviderConfig.mockImplementation((providerType: string) => {
      if (providerType === 'deepseek') {
        return {
          api: 'openai-completions',
          baseUrl: 'https://api.deepseek.com',
          apiKeyEnv: 'DEEPSEEK_API_KEY',
        };
      }
      return {
        api: 'openai-completions',
        baseUrl: 'https://api.moonshot.cn/v1',
        apiKeyEnv: 'MOONSHOT_API_KEY',
      };
    });

    const gateway = createGateway('running');
    await syncDefaultProviderToRuntime('ly-deepseek-default', gateway as GatewayManager);

    expect(mocks.updateAgentModel).toHaveBeenCalledWith('main', 'deepseek/deepseek-v4-flash');
    expect(mocks.updateAgentModel).toHaveBeenCalledWith('research', 'deepseek/deepseek-v4-flash');
    expect(mocks.updateAgentModel).toHaveBeenCalledWith('dingtalk', 'deepseek/deepseek-v4-flash');
    expect(gateway.rpc).toHaveBeenCalledWith('agents.update', {
      agentId: 'main',
      model: 'deepseek/deepseek-v4-flash',
    }, 10000);
    expect(gateway.rpc).toHaveBeenCalledWith('agents.update', {
      agentId: 'research',
      model: 'deepseek/deepseek-v4-flash',
    }, 10000);
    expect(gateway.rpc).toHaveBeenCalledWith('agents.update', {
      agentId: 'dingtalk',
      model: 'deepseek/deepseek-v4-flash',
    }, 10000);
  });

  it('syncs the main agent model to ly-auto/auto when auto is the default provider', async () => {
    mocks.getProvider.mockResolvedValue(createProvider({
      id: 'ly-auto',
      type: 'ly-auto',
      model: 'auto',
    }));
    mocks.getProviderConfig.mockImplementation((providerType: string) => {
      if (providerType === 'ly-auto') {
        return {
          api: 'openai-completions',
          baseUrl: 'https://ly-auto.example.com/v1',
          apiKeyEnv: 'LY_AUTO_API_KEY',
        };
      }
      return {
        api: 'openai-completions',
        baseUrl: 'https://api.moonshot.cn/v1',
        apiKeyEnv: 'MOONSHOT_API_KEY',
      };
    });

    const gateway = createGateway('running');
    await syncDefaultProviderToRuntime('ly-auto', gateway as GatewayManager);

    expect(mocks.updateAgentModel).toHaveBeenCalledWith('main', 'ly-auto/auto');
    expect(gateway.rpc).toHaveBeenCalledWith('agents.update', {
      agentId: 'main',
      model: 'ly-auto/auto',
    }, 10000);
  });

  it('uses gpt-5.4 as the browser OAuth default model for OpenAI', async () => {
    mocks.getProvider.mockResolvedValue(
      createProvider({
        id: 'openai-personal',
        type: 'openai',
        model: undefined,
      }),
    );
    mocks.getProviderAccount.mockResolvedValue({ authMode: 'oauth_browser' });
    mocks.getProviderSecret.mockResolvedValue({
      type: 'oauth',
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: 123,
      email: 'user@example.com',
      subject: 'project-1',
    });

    const gateway = createGateway('running');
    await syncDefaultProviderToRuntime('openai-personal', gateway as GatewayManager);

    expect(mocks.setOpenClawDefaultModel).toHaveBeenCalledWith(
      'openai-codex',
      'openai-codex/gpt-5.4',
      expect.any(Array),
    );
  });

  it('syncs a targeted agent model override to runtime provider registry', async () => {
    mocks.getAllProviders.mockResolvedValue([
      createProvider({
        id: 'ark',
        type: 'ark',
        model: 'doubao-pro',
      }),
    ]);
    mocks.getProviderConfig.mockImplementation((providerType: string) => {
      if (providerType === 'ark') {
        return {
          api: 'openai-completions',
          baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
          apiKeyEnv: 'ARK_API_KEY',
        };
      }
      return {
        api: 'openai-completions',
        baseUrl: 'https://api.moonshot.cn/v1',
        apiKeyEnv: 'MOONSHOT_API_KEY',
      };
    });
    mocks.listAgentsSnapshot.mockResolvedValue({
      agents: [
        {
          id: 'coder',
          modelRef: 'ark/ark-code-latest',
        },
      ],
    });

    await syncAgentModelOverrideToRuntime('coder');

    expect(mocks.updateSingleAgentModelProvider).toHaveBeenCalledWith(
      'coder',
      'ark',
      expect.objectContaining({
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
        api: 'openai-completions',
        models: [{ id: 'ark-code-latest', name: 'ark-code-latest' }],
      }),
    );
  });

  it('syncs custom vLLM provider models.json with streaming usage compat flags', async () => {
    const customProvider = createProvider({
      id: 'customa6',
      type: 'custom',
      name: 'MiniMax Direct',
      model: 'MiniMax-M2.7',
      baseUrl: 'http://10.64.22.11:8000/v1',
    });

    mocks.getProviderConfig.mockReturnValue(undefined);
    mocks.getApiKey.mockResolvedValue('sk-lyitech');

    const gateway = createGateway('running');
    await syncSavedProviderToRuntime(customProvider, undefined, gateway as GatewayManager);

    expect(mocks.syncProviderConfigToOpenClaw).toHaveBeenCalledWith(
      'custom-customa6',
      'MiniMax-M2.7',
      expect.objectContaining({
        timeoutSeconds: 900,
      }),
    );

    expect(mocks.updateAgentModelProvider).toHaveBeenCalledWith(
      'custom-customa6',
      expect.objectContaining({
        baseUrl: 'http://10.64.22.11:8000/v1',
        api: 'openai-completions',
        models: [
          expect.objectContaining({
            id: 'MiniMax-M2.7',
            name: 'MiniMax-M2.7',
            compat: expect.objectContaining({
              supportsUsageInStreaming: true,
              supportsPromptCacheKey: false,
            }),
          }),
        ],
      }),
    );
  });

  it('syncs custom DeepSeek V4 provider with raised maxTokens', async () => {
    const customProvider = createProvider({
      id: 'customb5',
      type: 'custom',
      name: 'DeepSeek',
      model: 'deepseek-v4-pro',
      baseUrl: 'https://api.deepseek.com',
    });

    mocks.getProviderConfig.mockReturnValue(undefined);
    mocks.getApiKey.mockResolvedValue('sk-test');

    const gateway = createGateway('running');
    await syncSavedProviderToRuntime(customProvider, undefined, gateway as GatewayManager);

    expect(mocks.syncProviderConfigToOpenClaw).toHaveBeenCalledWith(
      'custom-customb5',
      'deepseek-v4-pro',
      expect.objectContaining({
        modelOverrides: {
          'deepseek-v4-pro': expect.objectContaining({
            maxTokens: 384_000,
            contextWindow: 1_048_576,
            compat: expect.objectContaining({
              supportsUsageInStreaming: true,
              supportsPromptCacheKey: false,
            }),
          }),
        },
        timeoutSeconds: 900,
      }),
    );

    expect(mocks.updateAgentModelProvider).toHaveBeenCalledWith(
      'custom-customb5',
      expect.objectContaining({
        models: [expect.objectContaining({
          id: 'deepseek-v4-pro',
          maxTokens: 384_000,
          contextWindow: 1_048_576,
        })],
      }),
    );
  });

  it('syncs openclaw-seeded custom provider ids to the matching runtime key', async () => {
    const seededProvider = createProvider({
      id: 'custom-customb5',
      type: 'custom',
      name: 'DeepSeek',
      model: 'deepseek-v4-pro',
      baseUrl: 'https://api.deepseek.com',
    });

    expect(getOpenClawProviderKey('custom', 'custom-customb5')).toBe('custom-customb5');

    mocks.getProviderConfig.mockReturnValue(undefined);
    mocks.getApiKey.mockResolvedValue('sk-test');

    const gateway = createGateway('running');
    await syncSavedProviderToRuntime(seededProvider, undefined, gateway as GatewayManager);

    expect(mocks.syncProviderConfigToOpenClaw).toHaveBeenCalledWith(
      'custom-customb5',
      'deepseek-v4-pro',
      expect.objectContaining({
        modelOverrides: {
          'deepseek-v4-pro': expect.objectContaining({
            maxTokens: 384_000,
            contextWindow: 1_048_576,
          }),
        },
        timeoutSeconds: 900,
      }),
    );
  });

  it('syncs agent model override with streaming usage compat for custom providers', async () => {
    mocks.getAllProviders.mockResolvedValue([
      createProvider({
        id: 'customa6',
        type: 'custom',
        name: 'MiniMax Direct',
        model: 'MiniMax-M2.7',
        baseUrl: 'http://10.64.22.11:8000/v1',
      }),
    ]);
    mocks.getProviderConfig.mockReturnValue(undefined);
    mocks.getApiKey.mockResolvedValue('sk-lyitech');
    mocks.listAgentsSnapshot.mockResolvedValue({
      agents: [
        {
          id: 'main',
          modelRef: 'custom-customa6/MiniMax-M2.7',
        },
      ],
    });

    await syncAgentModelOverrideToRuntime('main');

    expect(mocks.updateSingleAgentModelProvider).toHaveBeenCalledWith(
      'main',
      'custom-customa6',
      expect.objectContaining({
        models: [
          expect.objectContaining({
            id: 'MiniMax-M2.7',
            name: 'MiniMax-M2.7',
            compat: expect.objectContaining({
              supportsUsageInStreaming: true,
              supportsPromptCacheKey: false,
            }),
          }),
        ],
      }),
    );
  });

  it('syncs Ollama provider config to runtime without adding model prefix', async () => {
    const ollamaProvider = createProvider({
      id: 'ollamafd',
      type: 'ollama',
      name: 'Ollama',
      model: 'qwen3:30b',
      baseUrl: 'http://localhost:11434/v1',
    });

    mocks.getProviderConfig.mockReturnValue(undefined);
    mocks.getProviderSecret.mockResolvedValue({ type: 'local', apiKey: 'ollama-local' });

    const gateway = createGateway('running');
    await syncSavedProviderToRuntime(ollamaProvider, undefined, gateway as GatewayManager);

    expect(mocks.syncProviderConfigToOpenClaw).toHaveBeenCalledWith(
      'ollama-ollamafd',
      'qwen3:30b',
      expect.objectContaining({
        baseUrl: 'http://localhost:11434/v1',
        api: 'openai-completions',
      }),
    );
    expect(gateway.debouncedReload).toHaveBeenCalledTimes(1);
  });

  it('syncs Ollama as default provider with correct baseUrl and api protocol', async () => {
    const ollamaProvider = createProvider({
      id: 'ollamafd',
      type: 'ollama',
      name: 'Ollama',
      model: 'qwen3:30b',
      baseUrl: 'http://localhost:11434/v1',
    });

    mocks.getProvider.mockResolvedValue(ollamaProvider);
    mocks.getDefaultProvider.mockResolvedValue('ollamafd');
    mocks.getProviderConfig.mockReturnValue(undefined);
    mocks.getApiKey.mockResolvedValue('ollama-local');

    const gateway = createGateway('running');
    await syncDefaultProviderToRuntime('ollamafd', gateway as GatewayManager);

    expect(mocks.setOpenClawDefaultModelWithOverride).toHaveBeenCalledWith(
      'ollama-ollamafd',
      'ollama-ollamafd/qwen3:30b',
      expect.objectContaining({
        baseUrl: 'http://localhost:11434/v1',
        api: 'openai-completions',
      }),
      expect.any(Array),
    );
  });
  it('syncs updated Ollama provider as default with correct override config', async () => {
    const ollamaProvider = createProvider({
      id: 'ollamafd',
      type: 'ollama',
      name: 'Ollama',
      model: 'qwen3:30b',
      baseUrl: 'http://localhost:11434/v1',
    });

    mocks.getProviderConfig.mockReturnValue(undefined);
    mocks.getProviderSecret.mockResolvedValue({ type: 'local', apiKey: 'ollama-local' });
    mocks.getDefaultProvider.mockResolvedValue('ollamafd');

    const gateway = createGateway('running');
    await syncUpdatedProviderToRuntime(ollamaProvider, undefined, gateway as GatewayManager);

    // Should use the custom/ollama branch with explicit override
    expect(mocks.setOpenClawDefaultModelWithOverride).toHaveBeenCalledWith(
      'ollama-ollamafd',
      'ollama-ollamafd/qwen3:30b',
      expect.objectContaining({
        baseUrl: 'http://localhost:11434/v1',
        api: 'openai-completions',
      }),
      expect.any(Array),
    );
    // Should NOT call the non-override path
    expect(mocks.setOpenClawDefaultModel).not.toHaveBeenCalled();
    expect(mocks.updateAgentModel).toHaveBeenCalledWith('main', 'ollama-ollamafd/qwen3:30b');
    expect(gateway.rpc).toHaveBeenCalledWith('agents.update', {
      agentId: 'main',
      model: 'ollama-ollamafd/qwen3:30b',
    }, 10000);
    expect(gateway.debouncedReload).not.toHaveBeenCalled();
  });

  it('removes Ollama provider from runtime on delete', async () => {
    const ollamaProvider = createProvider({
      id: 'ollamafd',
      type: 'ollama',
      name: 'Ollama',
      model: 'qwen3:30b',
      baseUrl: 'http://localhost:11434/v1',
    });

    const gateway = createGateway('running');
    await syncDeletedProviderToRuntime(ollamaProvider, 'ollamafd', gateway as GatewayManager);

    expect(mocks.removeProviderFromOpenClaw).toHaveBeenCalledWith('ollama-ollamafd');
    expect(mocks.removeProviderFromOpenClaw).toHaveBeenCalledWith('ollamafd');
    expect(gateway.debouncedRestart).toHaveBeenCalledTimes(1);
  });
});
