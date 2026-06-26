import type { GatewayManager } from '../../gateway/manager';
import { getProviderDefinition } from '../../shared/providers/registry';
import {
  LY_AUTO_PROVIDER_ID,
  type ProviderAccount,
} from '../../shared/providers/types';
import { readOpenClawConfig, writeOpenClawConfig } from '../../utils/channel-config';
import { withConfigLock } from '../../utils/config-mutex';
import { logger } from '../../utils/logger';
import { removeProviderFromOpenClaw, syncProviderConfigToOpenClaw, updateAgentModelProvider } from '../../utils/openclaw-auth';
import { getOpenClawProviderKeyForType } from '../../utils/provider-keys';
import { getProviderConfig } from '../../utils/provider-registry';
import { proxyAwareFetch } from '../../utils/proxy-fetch';
import { buildLyAutoModelOverrides, alignVllmCompilePluginState } from './ly-auto-compile-parity';
import { getProviderService } from './provider-service';
import { deleteProvider, storeApiKey } from '../../utils/secure-storage';
import { getProviderAccount, saveProviderAccount } from './provider-store';

const LY_AUTO_LABEL = 'LY-Auto';
const LY_AUTO_BASE_URL = 'http://10.64.10.48/v1';
const LY_AUTO_MODEL_ID = 'auto';
const LY_AUTO_API_KEY = 'EMPTY';

const OLD_LY_PROVIDER_IDS = ['ly-minimax', 'lyclaw-model', 'ly-deepseek', 'ly-qwen', 'ly-mimo'];

interface NginxModelEntry {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  compat?: Record<string, unknown>;
}

interface NginxModelConfigResponse {
  models: NginxModelEntry[];
}

async function fetchNginxModelConfig(baseUrl: string): Promise<NginxModelEntry | null> {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  const url = `${normalized}/lyclaw/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await proxyAwareFetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return null;
    const data = (await response.json()) as NginxModelConfigResponse;
    const models = data?.models;
    if (!Array.isArray(models) || models.length === 0) return null;
    return models.find((m) => m.id === 'auto') ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function buildModelOverrides(nginxEntry: NginxModelEntry | null): Record<string, unknown> {
  // Compat-only for compile parity; input modalities come from nginx or ly-auto default.
  return buildLyAutoModelOverrides(nginxEntry);
}

function createLyAutoAccount(existing?: ProviderAccount | null): ProviderAccount {
  const now = new Date().toISOString();
  return {
    id: LY_AUTO_PROVIDER_ID,
    vendorId: LY_AUTO_PROVIDER_ID,
    label: LY_AUTO_LABEL,
    authMode: 'api_key',
    baseUrl: LY_AUTO_BASE_URL,
    apiProtocol: 'openai-completions',
    headers: existing?.headers,
    model: LY_AUTO_MODEL_ID,
    fallbackModels: existing?.fallbackModels,
    fallbackAccountIds: existing?.fallbackAccountIds,
    enabled: true,
    isDefault: existing?.isDefault ?? true,
    metadata: {
      ...existing?.metadata,
      managedBy: 'lyclaw',
      readonly: true,
    },
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
}

async function migrateOldLyProvidersToAuto(): Promise<boolean> {
  return withConfigLock(async () => {
    const config = await readOpenClawConfig();
    let changed = false;

    // Clean up old provider entries from models.providers
    const models = (config.models && typeof config.models === 'object' ? config.models : {}) as Record<string, unknown>;
    const providers = (models.providers && typeof models.providers === 'object' ? models.providers : {}) as Record<string, unknown>;
    for (const oldId of OLD_LY_PROVIDER_IDS) {
      if (providers[oldId]) {
        delete providers[oldId];
        changed = true;
      }
    }
    if (changed) {
      models.providers = providers;
      config.models = models;
    }

    // Migrate default model ref to ly-auto/auto
    const agents = (config.agents && typeof config.agents === 'object' ? config.agents : {}) as Record<string, unknown>;
    const defaults = (agents.defaults && typeof agents.defaults === 'object' ? agents.defaults : {}) as Record<string, unknown>;
    const model = (defaults.model && typeof defaults.model === 'object' ? defaults.model : {}) as Record<string, unknown>;
    const primary = typeof model.primary === 'string' ? model.primary : '';

    // Check if primary is an old LY provider ref
    const isOldLyRef = OLD_LY_PROVIDER_IDS.some((oldId) =>
      primary.startsWith(`${oldId}/`) || primary === oldId
    );
    if (isOldLyRef || !primary) {
      model.primary = `${LY_AUTO_PROVIDER_ID}/${LY_AUTO_MODEL_ID}`;
      model.fallbacks = [];
      defaults.model = model;
      agents.defaults = defaults;
      config.agents = agents;
      changed = true;
    }

    if (changed) {
      await writeOpenClawConfig(config);
    }
    return changed;
  });
}

async function removeOldLyProviders(): Promise<void> {
  for (const oldId of OLD_LY_PROVIDER_IDS) {
    await deleteProvider(oldId);
    try {
      await removeProviderFromOpenClaw(oldId);
    } catch {
      // provider may not exist in openclaw.json
    }
  }
}

async function ensureOpenClawDefaultModel(modelRef: string): Promise<boolean> {
  return withConfigLock(async () => {
    const config = await readOpenClawConfig();
    const agents = (config.agents && typeof config.agents === 'object' ? config.agents : {}) as Record<string, unknown>;
    const defaults = (agents.defaults && typeof agents.defaults === 'object' ? agents.defaults : {}) as Record<string, unknown>;
    const model = (defaults.model && typeof defaults.model === 'object' ? defaults.model : {}) as Record<string, unknown>;
    const primary = typeof model.primary === 'string' ? model.primary : '';

    if (primary === modelRef) {
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
  await updateAgentModelProvider(runtimeProviderKey, {
    baseUrl: account.baseUrl,
    api: account.apiProtocol,
    models: [modelEntry],
    apiKey: LY_AUTO_API_KEY,
  });
}

export async function bootstrapLyManagedProviders(gatewayManager?: GatewayManager): Promise<void> {
  const providerService = getProviderService();

  // Migrate old LY providers to auto
  await migrateOldLyProvidersToAuto();
  await removeOldLyProviders();

  // Create or update ly-auto account
  const existing = await getProviderAccount(LY_AUTO_PROVIDER_ID);
  const account = createLyAutoAccount(existing);
  await saveProviderAccount(account);
  if (LY_AUTO_API_KEY) {
    await storeApiKey(account.id, LY_AUTO_API_KEY);
  }

  const definition = getProviderDefinition(LY_AUTO_PROVIDER_ID);
  const modelId = account.model || definition?.defaultModelId;
  const runtimeProviderKey = getOpenClawProviderKeyForType(account.vendorId, account.id);

  if (!modelId) {
    logger.warn('[provider-bootstrap] No model ID found for ly-auto, skipping sync');
    return;
  }

  // Fetch model config from nginx gateway, with hardcoded defaults as fallback
  const nginxBaseUrl = account.baseUrl || getProviderConfig(LY_AUTO_PROVIDER_ID)?.baseUrl || LY_AUTO_BASE_URL;
  const nginxConfig = await fetchNginxModelConfig(nginxBaseUrl);
  if (nginxConfig) {
    logger.info(`[provider-bootstrap] Fetched nginx model config: maxTokens=${nginxConfig.maxTokens}, contextWindow=${nginxConfig.contextWindow}`);
  } else {
    logger.warn('[provider-bootstrap] Failed to fetch nginx model config, using defaults');
  }
  const modelOverrides = buildModelOverrides(nginxConfig);

  // Sync provider config to openclaw.json
  await syncProviderConfigToOpenClaw(runtimeProviderKey, modelId, {
    baseUrl: account.baseUrl,
    api: account.apiProtocol,
    modelOverrides: {
      [LY_AUTO_MODEL_ID]: modelOverrides,
    },
  });

  // Sync to agent models.json
  await syncManagedProviderToAgentModels(account, LY_AUTO_MODEL_ID, modelOverrides);

  await alignVllmCompilePluginState();

  // Set default provider account
  const defaultProviderId = await providerService.getDefaultAccountId();
  if (!defaultProviderId || OLD_LY_PROVIDER_IDS.includes(defaultProviderId)) {
    await providerService.setDefaultAccount(account.id);
  }

  // Set default model
  const defaultModelRef = `${runtimeProviderKey}/${LY_AUTO_MODEL_ID}`;
  const changed = await ensureOpenClawDefaultModel(defaultModelRef);
  if (changed) {
    logger.info(`Configured default agent model to ${defaultModelRef}`);
    gatewayManager?.debouncedReload(undefined);
  }
}
