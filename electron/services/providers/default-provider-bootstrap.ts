import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import type { GatewayManager } from '../../gateway/manager';
import { getProviderDefinition } from '../../shared/providers/registry';
import {
  LEGACY_LY_MINIMAX_PROVIDER_ID,
  LY_MINIMAX_PROVIDER_ID,
  LY_DEEPSEEK_PROVIDER_ID,
  LY_QWEN_PROVIDER_ID,
  // LY_GLM_PROVIDER_ID,
  type ProviderAccount,
} from '../../shared/providers/types';
import { listConfiguredAgentIds } from '../../utils/agent-config';
import { readOpenClawConfig, writeOpenClawConfig } from '../../utils/channel-config';
import { withConfigLock } from '../../utils/config-mutex';
import { logger } from '../../utils/logger';
import { removeProviderFromOpenClaw, syncProviderConfigToOpenClaw, updateAgentModelProvider } from '../../utils/openclaw-auth';
import { getOpenClawConfigDir } from '../../utils/paths';
import { getOpenClawProviderKeyForType } from '../../utils/provider-keys';
import { getProviderService } from './provider-service';
import { deleteProvider, storeApiKey } from '../../utils/secure-storage';
import { deleteProviderAccount, getProviderAccount, saveProviderAccount } from './provider-store';

const LY_MINIMAX_LABEL = 'LY-MiniMax';
const LY_MINIMAX_BASE_URL = 'http://10.64.22.11:8000/v1';
const LY_MINIMAX_MODEL_ID = 'MiniMax-M2.7';
const LY_MINIMAX_CONTEXT_WINDOW = 100000;
const LY_MINIMAX_MAX_TOKENS = 16384;
const LY_MINIMAX_API_KEY = 'EMPTY';

const LY_MIMO_PROVIDER_ID = 'ly-mimo';
const LY_DEEPSEEK_LABEL = 'LY-DeepSeek';
const LY_DEEPSEEK_BASE_URL = 'http://10.7.221.62:8000/v1';
const LY_DEEPSEEK_MODEL_ID = 'deepseek-v4-flash';
const LY_DEEPSEEK_CONTEXT_WINDOW = 100000;
const LY_DEEPSEEK_MAX_TOKENS = 16384;
const LY_DEEPSEEK_API_KEY = 'EMPTY';

const LY_QWEN_LABEL = 'LY-Qwen';
const LY_QWEN_BASE_URL = 'http://10.64.22.12:8000/v1';
const LY_QWEN_MODEL_ID = 'qwen3.5-397b';
const LY_QWEN_CONTEXT_WINDOW = 100000;
const LY_QWEN_MAX_TOKENS = 16384;
const LY_QWEN_API_KEY = 'EMPTY';
const OPENAI_STREAM_USAGE_COMPAT = { supportsUsageInStreaming: true };

// const LY_GLM_LABEL = 'LY-GLM';
// const LY_GLM_BASE_URL = 'http://10.7.221.62:8000/v1';
// const LY_GLM_MODEL_ID = 'GLM-5.1-FP8';
// const LY_GLM_MAX_TOKENS = 167616;
// const LY_GLM_API_KEY = 'EMPTY';

function createLyMiniMaxAccount(existing?: ProviderAccount | null, legacy?: ProviderAccount | null): ProviderAccount {
  const now = new Date().toISOString();
  const source = existing ?? legacy;
  return {
    id: LY_MINIMAX_PROVIDER_ID,
    vendorId: LY_MINIMAX_PROVIDER_ID,
    label: LY_MINIMAX_LABEL,
    authMode: 'api_key',
    baseUrl: LY_MINIMAX_BASE_URL,
    apiProtocol: 'anthropic-messages',
    headers: source?.headers,
    model: LY_MINIMAX_MODEL_ID,
    fallbackModels: source?.fallbackModels,
    fallbackAccountIds: source?.fallbackAccountIds,
    enabled: true,
    isDefault: source?.isDefault ?? false,
    metadata: {
      ...source?.metadata,
      managedBy: 'lyclaw',
      readonly: true,
    },
    createdAt: source?.createdAt || now,
    updatedAt: now,
  };
}

function createLyDeepSeekAccount(existing?: ProviderAccount | null): ProviderAccount {
  const now = new Date().toISOString();
  return {
    id: LY_DEEPSEEK_PROVIDER_ID,
    vendorId: LY_DEEPSEEK_PROVIDER_ID,
    label: LY_DEEPSEEK_LABEL,
    authMode: 'api_key',
    baseUrl: existing?.baseUrl || LY_DEEPSEEK_BASE_URL,
    apiProtocol: 'openai-completions',
    headers: existing?.headers,
    model: LY_DEEPSEEK_MODEL_ID,
    fallbackModels: existing?.fallbackModels,
    fallbackAccountIds: existing?.fallbackAccountIds,
    enabled: true,
    isDefault: existing?.isDefault ?? false,
    metadata: {
      ...existing?.metadata,
      managedBy: 'lyclaw',
    },
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
}

function createLyQwenAccount(existing?: ProviderAccount | null): ProviderAccount {
  const now = new Date().toISOString();
  return {
    id: LY_QWEN_PROVIDER_ID,
    vendorId: LY_QWEN_PROVIDER_ID,
    label: LY_QWEN_LABEL,
    authMode: 'api_key',
    baseUrl: existing?.baseUrl || LY_QWEN_BASE_URL,
    apiProtocol: 'openai-completions',
    headers: existing?.headers,
    model: existing?.model || LY_QWEN_MODEL_ID,
    fallbackModels: existing?.fallbackModels,
    fallbackAccountIds: existing?.fallbackAccountIds,
    enabled: true,
    isDefault: existing?.isDefault ?? false,
    metadata: {
      ...existing?.metadata,
      managedBy: 'lyclaw',
    },
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
}

// function createLyGlmAccount(existing?: ProviderAccount | null): ProviderAccount {
//   const now = new Date().toISOString();
//   return {
//     id: LY_GLM_PROVIDER_ID,
//     vendorId: LY_GLM_PROVIDER_ID,
//     label: LY_GLM_LABEL,
//     authMode: 'api_key',
//     baseUrl: LY_GLM_BASE_URL,
//     apiProtocol: 'anthropic-messages',
//     headers: existing?.headers,
//     model: LY_GLM_MODEL_ID,
//     fallbackModels: existing?.fallbackModels,
//     fallbackAccountIds: existing?.fallbackAccountIds,
//     enabled: true,
//     isDefault: existing?.isDefault ?? false,
//     metadata: {
//       ...existing?.metadata,
//       managedBy: 'lyclaw',
//       readonly: true,
//     },
//     createdAt: existing?.createdAt || now,
//     updatedAt: now,
//   };
// }

function migrateModelRef(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(`${LEGACY_LY_MINIMAX_PROVIDER_ID}/`, `${LY_MINIMAX_PROVIDER_ID}/`);
  }
  return value;
}

async function migrateOpenClawConfigProviderId(): Promise<boolean> {
  return withConfigLock(async () => {
    const config = await readOpenClawConfig();
    let changed = false;

    const models = (config.models && typeof config.models === 'object' ? config.models : {}) as Record<string, unknown>;
    const providers = (models.providers && typeof models.providers === 'object' ? models.providers : {}) as Record<string, unknown>;
    if (providers[LEGACY_LY_MINIMAX_PROVIDER_ID]) {
      providers[LY_MINIMAX_PROVIDER_ID] = {
        ...(providers[LEGACY_LY_MINIMAX_PROVIDER_ID] as Record<string, unknown>),
        baseUrl: LY_MINIMAX_BASE_URL,
        api: 'anthropic-messages',
      };
      delete providers[LEGACY_LY_MINIMAX_PROVIDER_ID];
      models.providers = providers;
      config.models = models;
      changed = true;
    }

    const agents = (config.agents && typeof config.agents === 'object' ? config.agents : {}) as Record<string, unknown>;
    const defaults = (agents.defaults && typeof agents.defaults === 'object' ? agents.defaults : {}) as Record<string, unknown>;
    const model = (defaults.model && typeof defaults.model === 'object' ? defaults.model : {}) as Record<string, unknown>;
    const primary = migrateModelRef(model.primary);
    if (primary !== model.primary) {
      model.primary = primary;
      defaults.model = model;
      agents.defaults = defaults;
      config.agents = agents;
      changed = true;
    }
    if (Array.isArray(model.fallbacks)) {
      const nextFallbacks = model.fallbacks.map(migrateModelRef);
      if (JSON.stringify(nextFallbacks) !== JSON.stringify(model.fallbacks)) {
        model.fallbacks = nextFallbacks;
        defaults.model = model;
        agents.defaults = defaults;
        config.agents = agents;
        changed = true;
      }
    }

    if (changed) {
      await writeOpenClawConfig(config);
    }
    return changed;
  });
}

async function migrateAgentModelsJsonProviderId(): Promise<void> {
  let agentIds = await listConfiguredAgentIds();
  if (agentIds.length === 0) {
    agentIds = ['main'];
  }

  for (const agentId of agentIds) {
    const modelsPath = join(getOpenClawConfigDir(), 'agents', agentId, 'agent', 'models.json');
    try {
      const raw = await readFile(modelsPath, 'utf-8');
      const data = JSON.parse(raw) as Record<string, unknown>;
      const providers = (data.providers && typeof data.providers === 'object' ? data.providers : {}) as Record<string, unknown>;
      if (!providers[LEGACY_LY_MINIMAX_PROVIDER_ID]) {
        continue;
      }
      providers[LY_MINIMAX_PROVIDER_ID] = {
        ...(providers[LEGACY_LY_MINIMAX_PROVIDER_ID] as Record<string, unknown>),
        baseUrl: LY_MINIMAX_BASE_URL.replace(/\/v1$/, '/anthropic'),
        api: 'anthropic-messages',
      };
      delete providers[LEGACY_LY_MINIMAX_PROVIDER_ID];
      data.providers = providers;
      await writeFile(modelsPath, JSON.stringify(data, null, 2), 'utf-8');
      logger.info(`[provider-bootstrap] Migrated agent "${agentId}" models.json provider ${LEGACY_LY_MINIMAX_PROVIDER_ID} -> ${LY_MINIMAX_PROVIDER_ID}`);
    } catch {
      // Missing agent runtime files are created by Gateway; bootstrap will sync entries later.
    }
  }
}

async function removeRetiredLyMimoProvider(): Promise<void> {
  await deleteProvider(LY_MIMO_PROVIDER_ID);
  await removeProviderFromOpenClaw(LY_MIMO_PROVIDER_ID);
}

async function migrateLegacyProviderAccount(): Promise<ProviderAccount | null> {
  const legacy = await getProviderAccount(LEGACY_LY_MINIMAX_PROVIDER_ID);
  if (!legacy) {
    return null;
  }

  const current = await getProviderAccount(LY_MINIMAX_PROVIDER_ID);
  if (!current) {
    await saveProviderAccount(createLyMiniMaxAccount(null, legacy));
  }
  await deleteProviderAccount(LEGACY_LY_MINIMAX_PROVIDER_ID);
  return legacy;
}

async function ensureOpenClawDefaultModel(modelRef: string): Promise<boolean> {
  return withConfigLock(async () => {
    const config = await readOpenClawConfig();
    const agents = (config.agents && typeof config.agents === 'object' ? config.agents : {}) as Record<string, unknown>;
    const defaults = (agents.defaults && typeof agents.defaults === 'object' ? agents.defaults : {}) as Record<string, unknown>;
    const model = (defaults.model && typeof defaults.model === 'object' ? defaults.model : {}) as Record<string, unknown>;
    const primary = typeof model.primary === 'string' ? model.primary : '';

    if (primary && !primary.startsWith(`${LY_MINIMAX_PROVIDER_ID}/`) && primary !== LY_MINIMAX_MODEL_ID) {
      return false;
    }

    defaults.model = {
      ...model,
      primary: modelRef,
      fallbacks: Array.isArray(model.fallbacks) ? model.fallbacks : [],
    };
    agents.defaults = defaults;
    config.agents = agents;
    await writeOpenClawConfig(config);
    return true;
  });
}

async function syncManagedProviderToAgentModels(
  account: ProviderAccount,
  modelId: string,
  modelOptions: Record<string, unknown>,
): Promise<void> {
  const runtimeProviderKey = getOpenClawProviderKeyForType(account.vendorId, account.id);
  const modelEntry = { id: modelId, name: modelId, ...modelOptions };
  const baseUrl = account.apiProtocol === 'openai-completions'
    ? account.baseUrl?.replace(/\/$/, '')
    : account.baseUrl?.replace(/\/v1$/, '/anthropic').replace(/\/anthropic$/, '/anthropic');
  await updateAgentModelProvider(runtimeProviderKey, {
    baseUrl,
    api: account.apiProtocol,
    models: [modelEntry],
    apiKey: 'EMPTY',
  });
}

export async function bootstrapLyManagedProviders(gatewayManager?: GatewayManager): Promise<void> {
  const providerService = getProviderService();
  const legacyLyMiniMax = await migrateLegacyProviderAccount();
  await migrateOpenClawConfigProviderId();
  await migrateAgentModelsJsonProviderId();
  await removeRetiredLyMimoProvider();

  const existing = await providerService.getAccount(LY_MINIMAX_PROVIDER_ID);
  const account = createLyMiniMaxAccount(existing, legacyLyMiniMax);
  await saveProviderAccount(account);
  if (LY_MINIMAX_API_KEY) {
    await storeApiKey(account.id, LY_MINIMAX_API_KEY);
  }

  const definition = getProviderDefinition(LY_MINIMAX_PROVIDER_ID);
  const modelId = account.model || definition?.defaultModelId;
  const runtimeProviderKey = getOpenClawProviderKeyForType(account.vendorId, account.id);

  if (!modelId) {
    return;
  }

  await syncProviderConfigToOpenClaw(runtimeProviderKey, modelId, {
    baseUrl: account.baseUrl,
    api: account.apiProtocol,
    apiKeyEnv: 'LY_MINIMAX_API_KEY',
    modelOverrides: {
      [LY_MINIMAX_MODEL_ID]: {
        input: ['text'],
        contextWindow: LY_MINIMAX_CONTEXT_WINDOW,
        maxTokens: LY_MINIMAX_MAX_TOKENS,
      },
    },
  });
  await syncManagedProviderToAgentModels(account, LY_MINIMAX_MODEL_ID, {
    input: ['text'],
    contextWindow: LY_MINIMAX_CONTEXT_WINDOW,
    maxTokens: LY_MINIMAX_MAX_TOKENS,
  });

  const lyDeepSeekExisting = await providerService.getAccount(LY_DEEPSEEK_PROVIDER_ID);
  const lyDeepSeekAccount = createLyDeepSeekAccount(lyDeepSeekExisting);
  await saveProviderAccount(lyDeepSeekAccount);
  if (LY_DEEPSEEK_API_KEY) {
    await storeApiKey(lyDeepSeekAccount.id, LY_DEEPSEEK_API_KEY);
  }

  const defaultProviderId = await providerService.getDefaultAccountId();
  if (!defaultProviderId || defaultProviderId === LEGACY_LY_MINIMAX_PROVIDER_ID || defaultProviderId === account.id) {
    await providerService.setDefaultAccount(lyDeepSeekAccount.id);
  }

  const lyDeepSeekRuntimeProviderKey = getOpenClawProviderKeyForType(lyDeepSeekAccount.vendorId, lyDeepSeekAccount.id);
  await syncProviderConfigToOpenClaw(lyDeepSeekRuntimeProviderKey, LY_DEEPSEEK_MODEL_ID, {
    baseUrl: lyDeepSeekAccount.baseUrl || LY_DEEPSEEK_BASE_URL,
    api: lyDeepSeekAccount.apiProtocol,
    apiKeyEnv: 'LY_DEEPSEEK_API_KEY',
    modelOverrides: {
      'deepseek-v4-flash': {
        input: ['text'],
        contextWindow: LY_DEEPSEEK_CONTEXT_WINDOW,
        maxTokens: LY_DEEPSEEK_MAX_TOKENS,
        reasoning: true,
        compat: OPENAI_STREAM_USAGE_COMPAT,
      },
    },
  });
  await syncManagedProviderToAgentModels(lyDeepSeekAccount, LY_DEEPSEEK_MODEL_ID, {
    input: ['text'],
    contextWindow: LY_DEEPSEEK_CONTEXT_WINDOW,
    maxTokens: LY_DEEPSEEK_MAX_TOKENS,
    reasoning: true,
    compat: OPENAI_STREAM_USAGE_COMPAT,
  });

  const lyQwenExisting = await providerService.getAccount(LY_QWEN_PROVIDER_ID);
  const lyQwenAccount = createLyQwenAccount(lyQwenExisting);
  await saveProviderAccount(lyQwenAccount);
  if (LY_QWEN_API_KEY) {
    await storeApiKey(lyQwenAccount.id, LY_QWEN_API_KEY);
  }
  if (LY_QWEN_MODEL_ID) {
    const lyQwenRuntimeProviderKey = getOpenClawProviderKeyForType(lyQwenAccount.vendorId, lyQwenAccount.id);
    await syncProviderConfigToOpenClaw(lyQwenRuntimeProviderKey, LY_QWEN_MODEL_ID, {
      baseUrl: lyQwenAccount.baseUrl || LY_QWEN_BASE_URL,
      api: lyQwenAccount.apiProtocol,
      apiKeyEnv: 'LY_QWEN_API_KEY',
      modelOverrides: {
        [LY_QWEN_MODEL_ID]: {
          reasoning: true,
          input: ['text', 'image'],
          contextWindow: LY_QWEN_CONTEXT_WINDOW,
          maxTokens: LY_QWEN_MAX_TOKENS,
          compat: OPENAI_STREAM_USAGE_COMPAT,
        },
      },
    });
    await syncManagedProviderToAgentModels(lyQwenAccount, LY_QWEN_MODEL_ID, {
      reasoning: true,
      input: ['text', 'image'],
      contextWindow: LY_QWEN_CONTEXT_WINDOW,
      maxTokens: LY_QWEN_MAX_TOKENS,
      compat: OPENAI_STREAM_USAGE_COMPAT,
    });
  }

  // const lyGlmExisting = await providerService.getAccount(LY_GLM_PROVIDER_ID);
  // const lyGlmAccount = createLyGlmAccount(lyGlmExisting);
  // await saveProviderAccount(lyGlmAccount);
  // if (LY_GLM_API_KEY) {
  //   await storeApiKey(lyGlmAccount.id, LY_GLM_API_KEY);
  // }

  // const lyGlmRuntimeProviderKey = getOpenClawProviderKeyForType(lyGlmAccount.vendorId, lyGlmAccount.id);
  // await syncProviderConfigToOpenClaw(lyGlmRuntimeProviderKey, LY_GLM_MODEL_ID, {
  //   baseUrl: lyGlmAccount.baseUrl,
  //   api: lyGlmAccount.apiProtocol,
  //   apiKeyEnv: 'LY_GLM_API_KEY',
  //   modelOverrides: {
  //     [LY_GLM_MODEL_ID]: {
  //       maxTokens: LY_GLM_MAX_TOKENS,
  //     },
  //   },
  // });
  // await syncManagedProviderToAgentModels(lyGlmAccount, LY_GLM_MODEL_ID, { maxTokens: LY_GLM_MAX_TOKENS });

  const defaultModelRef = LY_DEEPSEEK_MODEL_ID.startsWith(`${lyDeepSeekRuntimeProviderKey}/`)
    ? LY_DEEPSEEK_MODEL_ID
    : `${lyDeepSeekRuntimeProviderKey}/${LY_DEEPSEEK_MODEL_ID}`;
  const changed = await ensureOpenClawDefaultModel(defaultModelRef);
  if (changed) {
    logger.info(`Configured default agent model to ${defaultModelRef}`);
    gatewayManager?.debouncedReload(undefined);
  }
}

