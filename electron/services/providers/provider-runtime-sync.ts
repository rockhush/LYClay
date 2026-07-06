import type { GatewayManager } from '../../gateway/manager';
import { getProviderAccount, listProviderAccounts } from './provider-store';
import { readOpenClawConfig, writeOpenClawConfig } from '../../utils/channel-config';
import { withConfigLock } from '../../utils/config-mutex';
import { getProviderSecret } from '../secrets/secret-store';
import type { ProviderConfig } from '../../utils/secure-storage';
import { getAllProviders, getApiKey, getDefaultProvider, getProvider } from '../../utils/secure-storage';
import { getProviderConfig, getProviderDefaultModel } from '../../utils/provider-registry';
import {
  ensureAgentContextTokensCapForLargeModels,
  ensureAgentModelsJsonValid,
  ensureModelCatalogContextTokensForLargeModels,
  migrateOpenClawAuthStoresToSqlite,
  removeProviderFromOpenClaw,
  removeProviderKeyFromOpenClaw,
  saveOAuthTokenToOpenClaw,
  saveProviderKeyToOpenClaw,
  setOpenClawDefaultModel,
  setOpenClawDefaultModelWithOverride,
  syncProviderConfigToOpenClaw,
  updateAgentModelProvider,
  updateSingleAgentModelProvider,
} from '../../utils/openclaw-auth';
import { logger } from '../../utils/logger';
import { listAgentsSnapshot, resetAgentModelsForProvider, updateAgentModel } from '../../utils/agent-config';
import { getSetting } from '../../utils/store';
import { LY_AUTO_PROVIDER_ID } from '../../shared/providers/types';
import { proxyAwareFetch } from '../../utils/proxy-fetch';
import {
  alignVllmCompilePluginState,
  buildLyAutoModelOverrides,
  LY_AUTO_REQUEST_TIMEOUT_SECONDS,
} from './ly-auto-compile-parity';
import { isDeepSeekV4ModelId, sanitizeOpenClawModelInput, syncOpenClawModelCatalogEntry } from './known-model-capabilities';
import { getOpenClawProviderKeyForType } from '../../utils/provider-keys';

const GOOGLE_OAUTH_RUNTIME_PROVIDER = 'google-gemini-cli';
const GOOGLE_OAUTH_DEFAULT_MODEL_REF = `${GOOGLE_OAUTH_RUNTIME_PROVIDER}/gemini-3-pro-preview`;
const OPENAI_OAUTH_RUNTIME_PROVIDER = 'openai-codex';
const OPENAI_OAUTH_DEFAULT_MODEL_REF = `${OPENAI_OAUTH_RUNTIME_PROVIDER}/gpt-5.4`;
const LY_MANAGED_PROVIDER_TYPES = new Set(['ly-auto']);

/** vLLM / openai-completions custom providers need streaming usage + no prompt_cache_key. */
const OPENAI_COMPLETIONS_STREAMING_COMPAT = {
  supportsUsageInStreaming: true,
  supportsPromptCacheKey: false,
};

function withOpenAICompletionsStreamingCompat(
  modelEntry: Record<string, unknown>,
): Record<string, unknown> {
  const existingCompat = modelEntry.compat && typeof modelEntry.compat === 'object' && !Array.isArray(modelEntry.compat)
    ? modelEntry.compat as Record<string, unknown>
    : {};
  return {
    ...modelEntry,
    compat: {
      ...existingCompat,
      ...OPENAI_COMPLETIONS_STREAMING_COMPAT,
    },
  };
}

function buildCustomOpenAICompletionsModels(
  modelId: string,
  baseUrl?: string,
  registryModel?: Record<string, unknown>,
): Array<Record<string, unknown> & { id: string; name: string }> {
  return [syncOpenClawModelCatalogEntry(
    modelId,
    withOpenAICompletionsStreamingCompat({
      ...(registryModel ?? {}),
      id: modelId,
      name: typeof registryModel?.name === 'string' ? registryModel.name : modelId,
    }),
    { baseUrl },
  ) as Record<string, unknown> & { id: string; name: string }];
}

async function fetchNginxModelOverrides(baseUrl: string): Promise<Record<string, unknown> | null> {
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
    const data = (await response.json()) as { models?: Array<Record<string, unknown>> };
    const models = data?.models;
    if (!Array.isArray(models) || models.length === 0) return null;
    const entry = models.find((m) => m.id === 'auto');
    return entry ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Provider types that are not in the built-in provider registry (no `providerConfig.api`).
 * They require explicit api-protocol defaulting to `openai-completions`.
 */
function isUnregisteredProviderType(type: string): boolean {
  return type === 'custom' || type === 'ollama';
}

function resolveProviderRequestTimeoutSeconds(type: string): number | undefined {
  if (type === LY_AUTO_PROVIDER_ID || type === 'custom') {
    return LY_AUTO_REQUEST_TIMEOUT_SECONDS;
  }
  return undefined;
}

type RuntimeProviderSyncContext = {
  runtimeProviderKey: string;
  meta: ReturnType<typeof getProviderConfig>;
  api: string;
};

function normalizeProviderBaseUrl(
  config: ProviderConfig,
  baseUrl?: string,
  apiProtocol?: string,
): string | undefined {
  if (!baseUrl) {
    return undefined;
  }

  const normalized = baseUrl.trim().replace(/\/+$/, '');

  if (config.type === 'minimax-portal' || config.type === 'minimax-portal-cn') {
    return normalized.replace(/\/v1$/, '').replace(/\/anthropic$/, '').replace(/\/$/, '') + '/anthropic';
  }

  if (isUnregisteredProviderType(config.type)) {
    const protocol = apiProtocol || config.apiProtocol || 'openai-completions';
    if (protocol === 'openai-responses') {
      return normalized.replace(/\/responses?$/i, '');
    }
    if (protocol === 'openai-completions') {
      return normalized.replace(/\/chat\/completions$/i, '');
    }
    if (protocol === 'anthropic-messages') {
      return normalized.replace(/\/v1\/messages$/i, '').replace(/\/messages$/i, '');
    }
  }

  return normalized;
}

function shouldUseExplicitDefaultOverride(config: ProviderConfig, runtimeProviderKey: string): boolean {
  return Boolean(config.baseUrl || config.apiProtocol || runtimeProviderKey !== config.type);
}

function canHotUpdateGateway(gatewayManager?: GatewayManager): boolean {
  return Boolean(
    gatewayManager
    && typeof gatewayManager.isConnected === 'function'
    && typeof gatewayManager.rpc === 'function'
    && gatewayManager.isConnected()
  );
}

export const getOpenClawProviderKey = getOpenClawProviderKeyForType;

async function resolveRuntimeProviderKey(config: ProviderConfig): Promise<string> {
  const account = await getProviderAccount(config.id);
  if (account?.authMode === 'oauth_browser') {
    if (config.type === 'google') {
      return GOOGLE_OAUTH_RUNTIME_PROVIDER;
    }
    if (config.type === 'openai') {
      return OPENAI_OAUTH_RUNTIME_PROVIDER;
    }
  }
  return getOpenClawProviderKey(config.type, config.id);
}

async function getBrowserOAuthRuntimeProvider(config: ProviderConfig): Promise<string | null> {
  const account = await getProviderAccount(config.id);
  if (account?.authMode !== 'oauth_browser') {
    return null;
  }

  const secret = await getProviderSecret(config.id);
  if (secret?.type !== 'oauth') {
    return null;
  }

  if (config.type === 'google') {
    return GOOGLE_OAUTH_RUNTIME_PROVIDER;
  }
  if (config.type === 'openai') {
    return OPENAI_OAUTH_RUNTIME_PROVIDER;
  }
  return null;
}

export function getProviderModelRef(config: ProviderConfig): string | undefined {
  const providerKey = getOpenClawProviderKey(config.type, config.id);

  if (config.model) {
    return config.model.startsWith(`${providerKey}/`)
      ? config.model
      : `${providerKey}/${config.model}`;
  }

  const defaultModel = getProviderDefaultModel(config.type);
  if (!defaultModel) {
    return undefined;
  }

  return defaultModel.startsWith(`${providerKey}/`)
    ? defaultModel
    : `${providerKey}/${defaultModel}`;
}

export async function getProviderFallbackModelRefs(config: ProviderConfig): Promise<string[]> {
  const allProviders = await getAllProviders();
  const providerMap = new Map(allProviders.map((provider) => [provider.id, provider]));
  const seen = new Set<string>();
  const results: string[] = [];
  const providerKey = getOpenClawProviderKey(config.type, config.id);

  for (const fallbackModel of config.fallbackModels ?? []) {
    const normalizedModel = fallbackModel.trim();
    if (!normalizedModel) continue;

    const modelRef = normalizedModel.startsWith(`${providerKey}/`)
      ? normalizedModel
      : `${providerKey}/${normalizedModel}`;

    if (seen.has(modelRef)) continue;
    seen.add(modelRef);
    results.push(modelRef);
  }

  for (const fallbackId of config.fallbackProviderIds ?? []) {
    if (!fallbackId || fallbackId === config.id) continue;

    const fallbackProvider = providerMap.get(fallbackId);
    if (!fallbackProvider) continue;

    const modelRef = getProviderModelRef(fallbackProvider);
    if (!modelRef || seen.has(modelRef)) continue;

    seen.add(modelRef);
    results.push(modelRef);
  }

  return results;
}

type GatewayRefreshMode = 'reload' | 'restart';

function scheduleGatewayRefresh(
  gatewayManager: GatewayManager | undefined,
  message: string,
  options?: { delayMs?: number; onlyIfRunning?: boolean; mode?: GatewayRefreshMode },
): void {
  if (!gatewayManager) {
    return;
  }

  if (options?.onlyIfRunning && gatewayManager.getStatus().state === 'stopped') {
    return;
  }

  logger.info(message);
  if (options?.mode === 'restart') {
    gatewayManager.debouncedRestart(options?.delayMs);
    return;
  }
  gatewayManager.debouncedReload(options?.delayMs);
}

export async function syncProviderApiKeyToRuntime(
  providerType: string,
  providerId: string,
  apiKey: string,
): Promise<void> {
  const ock = getOpenClawProviderKey(providerType, providerId);
  await saveProviderKeyToOpenClaw(ock, apiKey);
}

export async function syncAllProviderAuthToRuntime(): Promise<void> {
  try {
    await migrateOpenClawAuthStoresToSqlite();
  } catch (err) {
    logger.warn('[provider-runtime] Failed to migrate auth stores to SQLite:', err);
  }

  const accounts = await listProviderAccounts();

  for (const account of accounts) {
    const config: ProviderConfig = {
      id: account.id,
      name: account.label,
      type: account.vendorId,
      baseUrl: account.baseUrl,
      model: account.model,
      fallbackModels: account.fallbackModels,
      fallbackProviderIds: account.fallbackAccountIds,
      enabled: account.enabled,
      createdAt: account.createdAt,
    updatedAt: account.updatedAt,
      apiProtocol: account.apiProtocol,
      headers: account.headers,
    };

    // Sync both provider configuration and authentication
    // This ensures that when a session switches to this provider,
    // Gateway can find both the model configuration and credentials
    try {
      await syncProviderToRuntime(config, undefined);
    } catch (err) {
      logger.warn(`[provider-runtime] Failed to sync provider ${account.id} to runtime during bulk sync:`, err);
    }
  }

  try {
    await syncAgentModelsToRuntime();
  } catch (err) {
    logger.warn('[provider-runtime] Failed to sync per-agent model registries during bulk sync:', err);
  }

  try {
    const [catalogAligned, modelsJsonAligned] = await Promise.all([
      ensureModelCatalogContextTokensForLargeModels(),
      ensureAgentModelsJsonValid(),
    ]);
    if (catalogAligned) {
      logger.info('[provider-runtime] Aligned models.providers.*.contextTokens for large-context models');
    }
    if (modelsJsonAligned) {
      logger.info('[provider-runtime] Repaired agent models.json schema (input modalities / DeepSeek caps)');
    }
  } catch (err) {
    logger.warn('[provider-runtime] Failed to align model catalog contextTokens for large models:', err);
  }

  try {
    const raised = await ensureAgentContextTokensCapForLargeModels();
    if (raised) {
      logger.info('[provider-runtime] Raised agents.defaults.contextTokens for large-context models');
    }
  } catch (err) {
    logger.warn('[provider-runtime] Failed to align agents.defaults.contextTokens for large models:', err);
  }
}

async function syncProviderSecretToRuntime(
  config: ProviderConfig,
  runtimeProviderKey: string,
  apiKey: string | undefined,
): Promise<void> {
  const secret = await getProviderSecret(config.id);
  if (apiKey !== undefined) {
    const trimmedKey = apiKey.trim();
    if (trimmedKey) {
      await saveProviderKeyToOpenClaw(runtimeProviderKey, trimmedKey);
      return;
    }
  }

  if (secret?.type === 'api_key') {
    await saveProviderKeyToOpenClaw(runtimeProviderKey, secret.apiKey);
    return;
  }

  if (secret?.type === 'oauth') {
    await saveOAuthTokenToOpenClaw(runtimeProviderKey, {
      access: secret.accessToken,
      refresh: secret.refreshToken,
      expires: secret.expiresAt,
      email: secret.email,
      projectId: secret.subject,
    });
    return;
  }

  if (secret?.type === 'local' && secret.apiKey) {
    await saveProviderKeyToOpenClaw(runtimeProviderKey, secret.apiKey);
  }
}

async function resolveRuntimeSyncContext(config: ProviderConfig): Promise<RuntimeProviderSyncContext | null> {
  const runtimeProviderKey = await resolveRuntimeProviderKey(config);
  const meta = getProviderConfig(config.type);
  const api = config.apiProtocol || (isUnregisteredProviderType(config.type) ? 'openai-completions' : meta?.api);
  if (!api) {
    return null;
  }

  return {
    runtimeProviderKey,
    meta,
    api,
  };
}

/**
 * Build headers for ly-auto provider requests.
 *
 * Per-request session routing headers (`X-LYClaw-Session-Id`) and body `session_id`
 * are injected by the OpenClaw OpenAI transport patch (see scripts/openclaw-transport-patches.mjs)
 * using `sessionKey` / `sessionId` from `chat.send`.
 *
 * HAProxy should also set a machine-level fallback when the header is missing:
 *   http-request set-header X-LYClaw-Session-Id %[src] unless { req.hdr(X-LYClaw-Session-Id) -m found }
 *
 * Headers synced here:
 * - X-LYClaw-JobNumber: DingTalk job number from user profile (for future usage tracking)
 */
async function buildLyAutoHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};

  // Get DingTalk job number from user profile
  try {
    const dingtalkUser = await getSetting('dingtalkUser');
    if (dingtalkUser?.jobNumber) {
      headers['X-LYClaw-JobNumber'] = dingtalkUser.jobNumber;
    } else if (dingtalkUser?.userId) {
      // Fallback to userId if jobNumber is not available
      headers['X-LYClaw-JobNumber'] = dingtalkUser.userId;
    }
  } catch (error) {
    logger.warn('[provider-runtime-sync] Failed to get DingTalk user info for ly-auto headers:', error);
  }

  return headers;
}

async function syncRuntimeProviderConfig(
  config: ProviderConfig,
  context: RuntimeProviderSyncContext,
): Promise<void> {
  let modelOverrides = buildModelOverridesFromRegistry(context.meta?.models, config.model);

  // For ly-auto, fetch nginx input modalities while keeping compile-parity compat.
  if (config.type === LY_AUTO_PROVIDER_ID && modelOverrides && config.model) {
    const baseUrl = config.baseUrl || context.meta?.baseUrl;
    let nginxEntry: Record<string, unknown> | null = null;
    if (baseUrl) {
      nginxEntry = await fetchNginxModelOverrides(baseUrl);
      if (nginxEntry) {
        logger.info(
          `[provider-runtime-sync] Nginx model config: input=${JSON.stringify(nginxEntry.input)}, maxTokens=${nginxEntry.maxTokens}, contextWindow=${nginxEntry.contextWindow}`,
        );
        // Merge nginx fields into the base compat overrides so openclaw.json
        // reflects actual model capabilities (input, reasoning, contextWindow, etc.)
        const compat = buildLyAutoModelOverrides();
        if (nginxEntry.compat && typeof nginxEntry.compat === 'object') {
          Object.assign(compat.compat as Record<string, unknown>, nginxEntry.compat);
        }
        const overrides: Record<string, unknown> = { ...compat };
        if (typeof nginxEntry.reasoning === 'boolean') overrides.reasoning = nginxEntry.reasoning;
        if (Array.isArray(nginxEntry.input)) overrides.input = sanitizeOpenClawModelInput(nginxEntry.input);
        if (typeof nginxEntry.contextWindow === 'number') overrides.contextWindow = nginxEntry.contextWindow;
        if (typeof nginxEntry.maxTokens === 'number') overrides.maxTokens = nginxEntry.maxTokens;
        modelOverrides = { [config.model]: overrides };
      } else {
        logger.warn('[provider-runtime-sync] Failed to fetch nginx model config, using ly-auto defaults');
        modelOverrides = { [config.model]: buildLyAutoModelOverrides() };
      }
    } else {
      modelOverrides = { [config.model]: buildLyAutoModelOverrides() };
    }
  }

  // Custom/ollama vLLM endpoints need explicit streaming usage compat in openclaw.json too.
  const normalizedBaseUrl = normalizeProviderBaseUrl(config, config.baseUrl || context.meta?.baseUrl, context.api);
  if (config.model) {
    const baseOverride = isUnregisteredProviderType(config.type)
      ? withOpenAICompletionsStreamingCompat(modelOverrides?.[config.model] ?? {})
      : (modelOverrides?.[config.model] ?? {});
    modelOverrides = {
      ...modelOverrides,
      [config.model]: syncOpenClawModelCatalogEntry(config.model, baseOverride, { baseUrl: normalizedBaseUrl }),
    };
  }

  // Build headers: merge static headers from registry/config with dynamic ly-auto headers
  let headers = config.headers ?? context.meta?.headers;

  // For ly-auto provider, add dynamic headers (session ID and job number)
  if (config.type === LY_AUTO_PROVIDER_ID) {
    const lyAutoHeaders = await buildLyAutoHeaders();
    headers = { ...headers, ...lyAutoHeaders };
    logger.info('[provider-runtime-sync] Added ly-auto dynamic headers:', lyAutoHeaders);
  }

  await syncProviderConfigToOpenClaw(context.runtimeProviderKey, config.model, {
    baseUrl: normalizedBaseUrl,
    api: context.api,
    apiKeyEnv: context.meta?.apiKeyEnv,
    headers,
    timeoutSeconds: resolveProviderRequestTimeoutSeconds(config.type),
    modelOverrides,
  });

  if (config.type === LY_AUTO_PROVIDER_ID || isUnregisteredProviderType(config.type)) {
    await alignVllmCompilePluginState();
  }
}

function buildModelOverridesFromRegistry(
  registryModels: Array<Record<string, unknown>> | undefined,
  modelId: string | undefined,
): Record<string, Record<string, unknown>> | undefined {
  if (!registryModels || !modelId) {
    return undefined;
  }
  const model = registryModels.find((m) => m.id === modelId);
  if (!model) {
    return undefined;
  }
  return { [modelId]: { ...model } };
}

async function syncCustomProviderAgentModel(
  config: ProviderConfig,
  runtimeProviderKey: string,
  apiKey: string | undefined,
): Promise<void> {
  if (!isUnregisteredProviderType(config.type)) {
    return;
  }

  const resolvedKey = apiKey !== undefined ? (apiKey.trim() || null) : await getApiKey(config.id);
  if (!resolvedKey || !config.baseUrl) {
    return;
  }

  const modelId = config.model;
  const baseUrl = normalizeProviderBaseUrl(config, config.baseUrl, config.apiProtocol || 'openai-completions');
  await updateAgentModelProvider(runtimeProviderKey, {
    baseUrl,
    api: config.apiProtocol || 'openai-completions',
    models: modelId ? buildCustomOpenAICompletionsModels(modelId, baseUrl) : [],
    apiKey: resolvedKey,
  });
}

async function syncProviderToRuntime(
  config: ProviderConfig,
  apiKey: string | undefined,
): Promise<RuntimeProviderSyncContext | null> {
  const context = await resolveRuntimeSyncContext(config);
  if (!context) {
    return null;
  }

  await syncProviderSecretToRuntime(config, context.runtimeProviderKey, apiKey);
  await syncRuntimeProviderConfig(config, context);
  await syncCustomProviderAgentModel(config, context.runtimeProviderKey, apiKey);
  return context;
}

async function removeDeletedProviderFromOpenClaw(
  provider: ProviderConfig,
  providerId: string,
  runtimeProviderKey?: string,
): Promise<void> {
  const keys = new Set<string>();
  if (runtimeProviderKey) {
    keys.add(runtimeProviderKey);
  } else {
    keys.add(await resolveRuntimeProviderKey({ ...provider, id: providerId }));
  }
  keys.add(providerId);

  for (const key of keys) {
    await removeProviderFromOpenClaw(key);
  }
}

function parseModelRef(modelRef: string): { providerKey: string; modelId: string } | null {
  const trimmed = modelRef.trim();
  const separatorIndex = trimmed.indexOf('/');
  if (separatorIndex <= 0 || separatorIndex >= trimmed.length - 1) {
    return null;
  }

  return {
    providerKey: trimmed.slice(0, separatorIndex),
    modelId: trimmed.slice(separatorIndex + 1),
  };
}

async function setOpenClawDefaultModelRefOnly(modelRef: string, fallbackModels: string[]): Promise<void> {
  await withConfigLock(async () => {
    const config = await readOpenClawConfig();
    const agents = (config.agents && typeof config.agents === 'object' ? config.agents : {}) as Record<string, unknown>;
    const defaults = (agents.defaults && typeof agents.defaults === 'object' ? agents.defaults : {}) as Record<string, unknown>;
    defaults.model = {
      ...(defaults.model && typeof defaults.model === 'object' ? defaults.model as Record<string, unknown> : {}),
      primary: modelRef,
      fallbacks: fallbackModels,
    };
    agents.defaults = defaults;
    config.agents = agents;
    await writeOpenClawConfig(config);
  });
}

async function listDefaultModelSyncAgentIds(): Promise<string[]> {
  const agentIds = new Set<string>(['main']);
  try {
    const snapshot = await listAgentsSnapshot();
    for (const agent of snapshot.agents) {
      if (agent.id) agentIds.add(agent.id);
    }
  } catch (err) {
    logger.warn('[provider-runtime] Failed to list agents while syncing default model:', err);
  }
  return [...agentIds];
}

async function syncDefaultAgentModelRef(modelRef: string | undefined): Promise<string[]> {
  if (!modelRef) return [];
  const agentIds = await listDefaultModelSyncAgentIds();
  const syncedAgentIds: string[] = [];
  for (const agentId of agentIds) {
    try {
      await updateAgentModel(agentId, modelRef);
      syncedAgentIds.push(agentId);
    } catch (err) {
      logger.warn(`[provider-runtime] Failed to sync agent "${agentId}" model to default "${modelRef}":`, err);
    }
  }
  return syncedAgentIds;
}

async function hotUpdateGatewayAgentModels(
  gatewayManager: GatewayManager | undefined,
  agentIds: string[],
  modelRef: string,
  fallbackMessage: string,
  logSuffix = '',
): Promise<void> {
  if (!canHotUpdateGateway(gatewayManager)) return;
  try {
    const targetAgentIds = agentIds.length > 0 ? agentIds : ['main'];
    for (const agentId of targetAgentIds) {
      await gatewayManager!.rpc('agents.update', {
        agentId,
        model: modelRef,
      }, 10000);
    }
    logger.info(`[provider-runtime] Hot-reloaded default model to ${modelRef} for ${targetAgentIds.length} agent(s) via agents.update RPC${logSuffix}`);
  } catch (rpcError) {
    logger.warn('[provider-runtime] agents.update RPC failed, fallback to reload', rpcError);
    scheduleGatewayRefresh(gatewayManager, fallbackMessage, { onlyIfRunning: true });
  }
}

async function buildRuntimeProviderConfigMap(): Promise<Map<string, ProviderConfig>> {
  const configs = await getAllProviders();
  const runtimeMap = new Map<string, ProviderConfig>();

  for (const config of configs) {
    const runtimeKey = await resolveRuntimeProviderKey(config);
    runtimeMap.set(runtimeKey, config);
  }

  return runtimeMap;
}

async function buildAgentModelProviderEntry(
  config: ProviderConfig,
  modelId: string,
): Promise<{
  baseUrl?: string;
  api?: string;
  models?: Array<Record<string, unknown> & { id: string; name: string }>;
  apiKey?: string;
  authHeader?: boolean;
} | null> {
  const meta = getProviderConfig(config.type);
  const api = config.apiProtocol || (isUnregisteredProviderType(config.type) ? 'openai-completions' : meta?.api);
  const baseUrl = normalizeProviderBaseUrl(config, config.baseUrl || meta?.baseUrl, api);
  if (!api || !baseUrl) {
    return null;
  }

  let apiKey: string | undefined;
  let authHeader: boolean | undefined;

  if (isUnregisteredProviderType(config.type)) {
    apiKey = (await getApiKey(config.id)) || undefined;
  } else if (config.type === 'minimax-portal' || config.type === 'minimax-portal-cn') {
    const accountApiKey = await getApiKey(config.id);
    if (accountApiKey) {
      apiKey = accountApiKey;
    } else {
      authHeader = true;
      apiKey = 'minimax-oauth';
    }
  } else if (config.type === 'ly-auto') {
    apiKey = (await getApiKey(config.id)) || undefined;
  }

  const registryModel = meta?.models?.find((model) => model.id === modelId) as Record<string, unknown> | undefined;
  const useOpenAICompletionsCompat = api === 'openai-completions'
    && (isUnregisteredProviderType(config.type) || isDeepSeekV4ModelId(modelId));

  return {
    baseUrl,
    api,
    models: useOpenAICompletionsCompat
      ? buildCustomOpenAICompletionsModels(modelId, baseUrl, registryModel)
      : [{
          ...(registryModel ?? {}),
          id: modelId,
          name: typeof registryModel?.name === 'string' ? registryModel.name : modelId,
        } as Record<string, unknown> & { id: string; name: string }],
    apiKey,
    authHeader,
  };
}

async function syncAgentModelsToRuntime(agentIds?: Set<string>): Promise<void> {
  const snapshot = await listAgentsSnapshot();
  const runtimeProviderConfigs = await buildRuntimeProviderConfigMap();

  const targets = snapshot.agents.filter((agent) => {
    if (!agent.modelRef) return false;
    if (!agentIds) return true;
    return agentIds.has(agent.id);
  });

  for (const agent of targets) {
    const parsed = parseModelRef(agent.modelRef || '');
    if (!parsed) {
      continue;
    }

    const providerConfig = runtimeProviderConfigs.get(parsed.providerKey);
    if (!providerConfig) {
      logger.warn(
        `[provider-runtime] No provider account mapped to runtime key "${parsed.providerKey}" for agent "${agent.id}"`,
      );
      continue;
    }

    const entry = await buildAgentModelProviderEntry(providerConfig, parsed.modelId);
    if (!entry) {
      continue;
    }

    await updateSingleAgentModelProvider(agent.id, parsed.providerKey, entry);
  }
}

export async function syncAgentModelOverrideToRuntime(agentId: string): Promise<void> {
  await syncAgentModelsToRuntime(new Set([agentId]));
}

export async function syncSavedProviderToRuntime(
  config: ProviderConfig,
  apiKey: string | undefined,
  gatewayManager?: GatewayManager,
): Promise<void> {
  const context = await syncProviderToRuntime(config, apiKey);
  if (!context) {
    return;
  }

  let defaultSyncedAgentIds: string[] = [];
  try {
    if (config.id === await getDefaultProvider()) {
      defaultSyncedAgentIds = await syncDefaultAgentModelRef(getProviderModelRef(config));
    }
    await syncAgentModelsToRuntime();
  } catch (err) {
    logger.warn('[provider-runtime] Failed to sync per-agent model registries after provider save:', err);
  }

  // 热更新：如果该 provider 是默认 provider，直接通过 RPC 更新模型
  if (canHotUpdateGateway(gatewayManager) && config.id === await getDefaultProvider()) {
    const modelRef = getProviderModelRef(config);
    if (modelRef) {
      await hotUpdateGatewayAgentModels(
        gatewayManager,
        defaultSyncedAgentIds,
        modelRef,
        `Scheduling Gateway reload after saving provider "${context.runtimeProviderKey}" config (fallback)`,
        ' after provider save',
      );
    }
  } else {
    scheduleGatewayRefresh(
      gatewayManager,
      `Scheduling Gateway reload after saving provider "${context.runtimeProviderKey}" config`,
    );
  }
}

export async function syncUpdatedProviderToRuntime(
  config: ProviderConfig,
  apiKey: string | undefined,
  gatewayManager?: GatewayManager,
): Promise<void> {
  const context = await syncProviderToRuntime(config, apiKey);
  if (!context) {
    return;
  }

  const ock = context.runtimeProviderKey;
  const fallbackModels = await getProviderFallbackModelRefs(config);

  const defaultProviderId = await getDefaultProvider();
  if (defaultProviderId === config.id) {
    const modelOverride = config.model ? `${ock}/${config.model}` : undefined;
    if (!isUnregisteredProviderType(config.type)) {
      if (shouldUseExplicitDefaultOverride(config, ock)) {
        await setOpenClawDefaultModelWithOverride(ock, modelOverride, {
          baseUrl: normalizeProviderBaseUrl(config, config.baseUrl || context.meta?.baseUrl, context.api),
          api: context.api,
          apiKeyEnv: context.meta?.apiKeyEnv,
          headers: config.headers ?? context.meta?.headers,
        }, fallbackModels);
      } else {
        await setOpenClawDefaultModel(ock, modelOverride, fallbackModels);
      }
    } else {
      await setOpenClawDefaultModelWithOverride(ock, modelOverride, {
        baseUrl: normalizeProviderBaseUrl(config, config.baseUrl, config.apiProtocol || 'openai-completions'),
        api: config.apiProtocol || 'openai-completions',
        headers: config.headers,
      }, fallbackModels);
    }
  }

  let defaultSyncedAgentIds: string[] = [];
  try {
    if (defaultProviderId === config.id) {
      defaultSyncedAgentIds = await syncDefaultAgentModelRef(getProviderModelRef(config));
    }
    await syncAgentModelsToRuntime();
  } catch (err) {
    logger.warn('[provider-runtime] Failed to sync per-agent model registries after provider update:', err);
  }

  // 热更新：如果该 provider 是默认 provider，直接通过 RPC 更新模型
  if (canHotUpdateGateway(gatewayManager) && defaultProviderId === config.id) {
    const modelRef = getProviderModelRef(config);
    if (modelRef) {
      await hotUpdateGatewayAgentModels(
        gatewayManager,
        defaultSyncedAgentIds,
        modelRef,
        `Scheduling Gateway reload after updating provider "${ock}" config (fallback)`,
        ' after provider update',
      );
    }
  } else {
    scheduleGatewayRefresh(
      gatewayManager,
      `Scheduling Gateway reload after updating provider "${ock}" config`,
    );
  }
}

export async function syncDeletedProviderToRuntime(
  provider: ProviderConfig | null,
  providerId: string,
  gatewayManager?: GatewayManager,
  runtimeProviderKey?: string,
): Promise<void> {
  if (!provider?.type) {
    return;
  }

  const ock = runtimeProviderKey ?? await resolveRuntimeProviderKey({ ...provider, id: providerId });
  await removeDeletedProviderFromOpenClaw(provider, providerId, ock);

  // Reset agent model overrides that reference the deleted provider,
  // so agents fall back to the global default model instead of keeping
  // a stale binding to a now-removed provider.
  try {
    await resetAgentModelsForProvider(ock);
  } catch (err) {
    logger.warn(`[provider-runtime] Failed to reset agent models after deleting provider "${ock}":`, err);
  }

  scheduleGatewayRefresh(
    gatewayManager,
    `Scheduling Gateway restart after deleting provider "${ock}"`,
    { mode: 'restart' },
  );
}

export async function syncDeletedProviderApiKeyToRuntime(
  provider: ProviderConfig | null,
  providerId: string,
  runtimeProviderKey?: string,
): Promise<void> {
  if (!provider?.type) {
    return;
  }

  const ock = runtimeProviderKey ?? await resolveRuntimeProviderKey({ ...provider, id: providerId });
  await removeProviderKeyFromOpenClaw(ock);
}

export async function syncDefaultProviderToRuntime(
  providerId: string,
  gatewayManager?: GatewayManager,
): Promise<void> {
  const provider = await getProvider(providerId);
  if (!provider) {
    return;
  }

  const ock = await resolveRuntimeProviderKey(provider);
  const providerKey = await getApiKey(providerId);
  const fallbackModels = await getProviderFallbackModelRefs(provider);
  const oauthTypes = ['minimax-portal', 'minimax-portal-cn'];
  const browserOAuthRuntimeProvider = await getBrowserOAuthRuntimeProvider(provider);
  const isOAuthProvider = (oauthTypes.includes(provider.type) && !providerKey) || Boolean(browserOAuthRuntimeProvider);
  let defaultAgentModelRef: string | undefined;

  if (!isOAuthProvider) {
    const modelOverride = provider.model
      ? (provider.model.startsWith(`${ock}/`) ? provider.model : `${ock}/${provider.model}`)
      : undefined;

    if (isUnregisteredProviderType(provider.type)) {
      await setOpenClawDefaultModelWithOverride(ock, modelOverride, {
        baseUrl: normalizeProviderBaseUrl(provider, provider.baseUrl, provider.apiProtocol || 'openai-completions'),
        api: provider.apiProtocol || 'openai-completions',
        headers: provider.headers,
      }, fallbackModels);
    } else if (LY_MANAGED_PROVIDER_TYPES.has(provider.type)) {
      const managedModelRef = getProviderModelRef(provider);
      if (managedModelRef) {
        await setOpenClawDefaultModelRefOnly(managedModelRef, fallbackModels);
      }
    } else if (shouldUseExplicitDefaultOverride(provider, ock)) {
      await setOpenClawDefaultModelWithOverride(ock, modelOverride, {
        baseUrl: normalizeProviderBaseUrl(
          provider,
          provider.baseUrl || getProviderConfig(provider.type)?.baseUrl,
          provider.apiProtocol || getProviderConfig(provider.type)?.api,
        ),
        api: provider.apiProtocol || getProviderConfig(provider.type)?.api,
        apiKeyEnv: getProviderConfig(provider.type)?.apiKeyEnv,
        headers: provider.headers ?? getProviderConfig(provider.type)?.headers,
      }, fallbackModels);
    } else {
      await setOpenClawDefaultModel(ock, modelOverride, fallbackModels);
    }

    if (providerKey) {
      await saveProviderKeyToOpenClaw(ock, providerKey);
    }
    defaultAgentModelRef = getProviderModelRef(provider);
  } else {
    if (browserOAuthRuntimeProvider) {
      const secret = await getProviderSecret(provider.id);
      if (secret?.type === 'oauth') {
        await saveOAuthTokenToOpenClaw(browserOAuthRuntimeProvider, {
          access: secret.accessToken,
          refresh: secret.refreshToken,
          expires: secret.expiresAt,
          email: secret.email,
          projectId: secret.subject,
        });
      }

      const defaultModelRef = browserOAuthRuntimeProvider === GOOGLE_OAUTH_RUNTIME_PROVIDER
        ? GOOGLE_OAUTH_DEFAULT_MODEL_REF
        : OPENAI_OAUTH_DEFAULT_MODEL_REF;
      const modelOverride = provider.model
        ? (provider.model.startsWith(`${browserOAuthRuntimeProvider}/`)
          ? provider.model
          : `${browserOAuthRuntimeProvider}/${provider.model}`)
        : defaultModelRef;

      await setOpenClawDefaultModel(browserOAuthRuntimeProvider, modelOverride, fallbackModels);
      defaultAgentModelRef = modelOverride;
      logger.info(`Configured openclaw.json for browser OAuth provider "${provider.id}"`);
      let defaultSyncedAgentIds: string[] = [];
      try {
        defaultSyncedAgentIds = await syncDefaultAgentModelRef(defaultAgentModelRef);
        await syncAgentModelsToRuntime();
      } catch (err) {
        logger.warn('[provider-runtime] Failed to sync per-agent model registries after browser OAuth switch:', err);
      }

      // 热更新：直接通过 RPC 让 Gateway 更新模型配置
      if (canHotUpdateGateway(gatewayManager)) {
        await hotUpdateGatewayAgentModels(
          gatewayManager,
          defaultSyncedAgentIds,
          modelOverride,
          `Scheduling Gateway reload after provider switch to "${browserOAuthRuntimeProvider}" (fallback)`,
          ' after browser OAuth switch',
        );
      }
      return;
    }

    const defaultBaseUrl = provider.type === 'minimax-portal'
      ? 'https://api.minimax.io/anthropic'
      : 'https://api.minimaxi.com/anthropic';
    const api = 'anthropic-messages' as const;

    let baseUrl = provider.baseUrl || defaultBaseUrl;
    if (baseUrl) {
      baseUrl = baseUrl.replace(/\/v1$/, '').replace(/\/anthropic$/, '').replace(/\/$/, '') + '/anthropic';
    }

    const targetProviderKey = 'minimax-portal';

    await setOpenClawDefaultModelWithOverride(targetProviderKey, getProviderModelRef(provider), {
      baseUrl,
      api,
      authHeader: targetProviderKey === 'minimax-portal' ? true : undefined,
      apiKeyEnv: targetProviderKey === 'minimax-portal' ? 'minimax-oauth' : 'qwen-oauth',
    }, fallbackModels);
    defaultAgentModelRef = getProviderModelRef(provider);

    logger.info(`Configured openclaw.json for OAuth provider "${provider.type}"`);

    try {
      const defaultModelId = provider.model?.split('/').pop();
      await updateAgentModelProvider(targetProviderKey, {
        baseUrl,
        api,
        authHeader: targetProviderKey === 'minimax-portal' ? true : undefined,
        apiKey: targetProviderKey === 'minimax-portal' ? 'minimax-oauth' : 'qwen-oauth',
        models: defaultModelId ? [{ id: defaultModelId, name: defaultModelId }] : [],
      });
    } catch (err) {
      logger.warn(`Failed to update models.json for OAuth provider "${targetProviderKey}":`, err);
    }
  }

  if (
    isUnregisteredProviderType(provider.type) &&
    providerKey &&
    provider.baseUrl
  ) {
    const modelId = provider.model;
    await updateAgentModelProvider(ock, {
      baseUrl: normalizeProviderBaseUrl(provider, provider.baseUrl, provider.apiProtocol || 'openai-completions'),
      api: provider.apiProtocol || 'openai-completions',
      models: modelId ? [{ id: modelId, name: modelId }] : [],
      apiKey: providerKey,
    });
  }

  let defaultSyncedAgentIds: string[] = [];
  try {
    defaultSyncedAgentIds = await syncDefaultAgentModelRef(defaultAgentModelRef);
    await syncAgentModelsToRuntime();
  } catch (err) {
    logger.warn('[provider-runtime] Failed to sync per-agent model registries after default provider switch:', err);
  }

  // 热更新：直接通过 RPC 让 Gateway 更新模型配置
  if (canHotUpdateGateway(gatewayManager)) {
    const modelRef = getProviderModelRef(provider);
    if (modelRef) {
      await hotUpdateGatewayAgentModels(
        gatewayManager,
        defaultSyncedAgentIds,
        modelRef,
        `Scheduling Gateway reload after provider switch to "${ock}" (fallback)`,
      );
    }
  }
}
