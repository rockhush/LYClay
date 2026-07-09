import type { GatewayManager } from '../gateway/manager';
import type { ProviderAccount } from '../shared/providers/types';
import { deleteProviderAccount, listProviderAccounts, saveProviderAccount } from '../services/providers/provider-store';
import { syncDeletedProviderToRuntime, syncSavedProviderToRuntime } from '../services/providers/provider-runtime-sync';
import { deleteProviderSecret, setProviderSecret } from '../services/secrets/secret-store';
import { hashSub2ApiSubject, type GlobalSub2ApiSubject } from './sub2api-subject';
import { setDefaultProvider } from './secure-storage';
import { LY_AUTO_REQUEST_TIMEOUT_SECONDS } from '../services/providers/ly-auto-compile-parity';
import type { ProviderConfig } from './secure-storage';

export type NormalizedSub2ApiModel = {
  modelId: string;
  displayName?: string;
  input?: string[];
  contextWindow?: number;
  contextTokens?: number;
  maxTokens?: number;
  timeoutSeconds?: number;
  reasoning?: boolean;
  compat?: Record<string, unknown>;
};

export type NormalizedSub2ApiCredential = {
  credentialId: string;
  apiKey: string;
  baseUrl: string;
  models: Array<string | NormalizedSub2ApiModel>;
};

export type ReconcileSub2ApiProvidersResult = {
  status: 'updated' | 'cleared-empty-models';
  providerIds: string[];
  subjectHash: string;
  modelCount: number;
};

export type ReconcileSub2ApiProviderOptions = {
  now?: string;
  gatewayManager?: GatewayManager;
};

type Sub2ApiManagedMetadata = NonNullable<ProviderAccount['metadata']> & {
  managedBy: 'sub2api';
  scope: 'global' | 'digitalEmployee';
  subjectHash: string;
};

function isSub2ApiManagedForSubject(
  account: ProviderAccount,
  scope: Sub2ApiManagedMetadata['scope'],
  subjectHash: string,
): boolean {
  return account.metadata?.managedBy === 'sub2api'
    && account.metadata.scope === scope
    && account.metadata.subjectHash === subjectHash;
}

function normalizeModelId(model: string | NormalizedSub2ApiModel): string | null {
  const modelId = typeof model === 'string' ? model : model.modelId;
  const trimmed = modelId?.trim();
  return trimmed || null;
}

const SUB2API_DEFAULT_CONTEXT_WINDOW = 200000;
const SUB2API_DEFAULT_MAX_TOKENS = 16384;
const SUB2API_DEFAULT_INPUT = ['text', 'image'] as const;

function normalizeSub2ApiInput(input: unknown): string[] {
  if (!Array.isArray(input)) return [...SUB2API_DEFAULT_INPUT];
  const normalized = input.filter((value): value is string => value === 'text' || value === 'image');
  return normalized.length > 0 ? normalized : [...SUB2API_DEFAULT_INPUT];
}

function normalizeSub2ApiCompat(compat: unknown): Record<string, unknown> {
  const base = compat && typeof compat === 'object' && !Array.isArray(compat)
    ? compat as Record<string, unknown>
    : {};
  return {
    supportsUsageInStreaming: true,
    thinkingFormat: 'qwen-chat-template',
    maxTokensField: 'max_tokens',
    ...base,
    supportsPromptCacheKey: true,
  };
}

export function completeSub2ApiRuntimeModel(
  model: string | NormalizedSub2ApiModel | (Record<string, unknown> & { id?: string; modelId?: string }),
): Record<string, unknown> & { id: string; name: string } | null {
  const modelId = normalizeModelId(typeof model === 'string'
    ? model
    : { ...model, modelId: typeof model.modelId === 'string' ? model.modelId : model.id });
  if (!modelId) return null;
  const source = typeof model === 'string' ? {} : model as Record<string, unknown>;
  const contextWindow = typeof source.contextWindow === 'number' && Number.isFinite(source.contextWindow) && source.contextWindow > 0
    ? Math.floor(source.contextWindow)
    : SUB2API_DEFAULT_CONTEXT_WINDOW;
  const contextTokens = typeof source.contextTokens === 'number' && Number.isFinite(source.contextTokens) && source.contextTokens > 0
    ? Math.floor(source.contextTokens)
    : contextWindow;
  return {
    ...source,
    id: modelId,
    modelId,
    name: typeof source.name === 'string' && source.name.trim()
      ? source.name.trim()
      : `LY-${modelId}`,
    input: normalizeSub2ApiInput(source.input),
    contextWindow,
    contextTokens,
    maxTokens: typeof source.maxTokens === 'number' && Number.isFinite(source.maxTokens) && source.maxTokens > 0
      ? Math.floor(source.maxTokens)
      : SUB2API_DEFAULT_MAX_TOKENS,
    timeoutSeconds: typeof source.timeoutSeconds === 'number' && Number.isFinite(source.timeoutSeconds) && source.timeoutSeconds > 0
      ? Math.floor(source.timeoutSeconds)
      : LY_AUTO_REQUEST_TIMEOUT_SECONDS,
    reasoning: typeof source.reasoning === 'boolean' ? source.reasoning : true,
    compat: normalizeSub2ApiCompat(source.compat),
  };
}
function normalizeCredentialModels(
  credential: NormalizedSub2ApiCredential,
): Array<Record<string, unknown> & { id: string; name: string }> {
  const seen = new Set<string>();
  const models: Array<Record<string, unknown> & { id: string; name: string }> = [];
  for (const model of credential.models) {
    const completed = completeSub2ApiRuntimeModel(model);
    if (!completed || seen.has(completed.id)) continue;
    seen.add(completed.id);
    models.push(completed);
  }
  return models;
}

function safeIdSegment(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 80) || 'credential';
}

function buildProviderId(scope: GlobalSub2ApiSubject['scope'], subjectHash: string, credentialId: string): string {
  return `sub2api-${scope}-${subjectHash}-${safeIdSegment(credentialId)}`;
}

function accountToConfig(account: ProviderAccount): ProviderConfig {
  return {
    id: account.id,
    name: account.label,
    type: account.vendorId,
    baseUrl: account.baseUrl,
    apiProtocol: account.apiProtocol,
    headers: account.headers,
    model: account.model,
    fallbackModels: account.fallbackModels,
    fallbackProviderIds: account.fallbackAccountIds,
    runtimeModels: account.runtimeModels,
    metadata: account.metadata,
    enabled: account.enabled,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

async function deleteManagedProviderAccount(account: ProviderAccount, gatewayManager?: GatewayManager): Promise<void> {
  await syncDeletedProviderToRuntime(accountToConfig(account), account.id, gatewayManager);
  await deleteProviderSecret(account.id);
  await deleteProviderAccount(account.id);
}

export async function reconcileGlobalSub2ApiProviders(
  subject: GlobalSub2ApiSubject,
  normalizedCredentials: NormalizedSub2ApiCredential[],
  options: ReconcileSub2ApiProviderOptions = {},
): Promise<ReconcileSub2ApiProvidersResult> {
  const subjectHash = hashSub2ApiSubject(subject.scope, subject.userNo);
  const now = options.now ?? new Date().toISOString();
  const usableCredentials = normalizedCredentials
    .map((credential) => ({ credential, runtimeModels: normalizeCredentialModels(credential) }))
    .filter((entry) => entry.runtimeModels.length > 0);

  const existingAccounts = await listProviderAccounts();

  if (usableCredentials.length === 0) {
    for (const account of existingAccounts) {
      if (!isSub2ApiManagedForSubject(account, subject.scope, subjectHash)) continue;
      await deleteManagedProviderAccount(account, options.gatewayManager);
    }
    return {
      status: 'cleared-empty-models',
      providerIds: [],
      subjectHash,
      modelCount: 0,
    };
  }

  const nextAccounts = new Map<string, ProviderAccount>();
  for (const { credential, runtimeModels } of usableCredentials) {
    const providerId = buildProviderId(subject.scope, subjectHash, credential.credentialId);
    nextAccounts.set(providerId, {
      id: providerId,
      vendorId: 'custom',
      label: 'LY-SUB2API',
      authMode: 'api_key',
      baseUrl: credential.baseUrl,
      apiProtocol: 'openai-completions',
      model: runtimeModels[0]?.id,
      fallbackModels: runtimeModels.map((model) => model.id),
      runtimeModels,
      enabled: true,
      isDefault: false,
      metadata: {
        managedBy: 'sub2api',
        scope: subject.scope,
        subjectHash,
        hiddenInProviderSettings: false,
        lastSuccessAt: now,
      },
      createdAt: now,
      updatedAt: now,
    });
  }

  for (const account of existingAccounts) {
    if (!isSub2ApiManagedForSubject(account, subject.scope, subjectHash)) continue;
    if (nextAccounts.has(account.id)) continue;
    await deleteManagedProviderAccount(account, options.gatewayManager);
  }

  const defaultProviderId = buildProviderId(subject.scope, subjectHash, usableCredentials[0].credential.credentialId);

  for (const { credential } of usableCredentials) {
    const providerId = buildProviderId(subject.scope, subjectHash, credential.credentialId);
    const account = nextAccounts.get(providerId);
    if (!account) continue;
    await saveProviderAccount(account);
    await setProviderSecret({ type: 'api_key', accountId: account.id, apiKey: credential.apiKey });
    if (account.id === defaultProviderId) {
      await setDefaultProvider(account.id);
    }
    await syncSavedProviderToRuntime(accountToConfig(account), credential.apiKey, options.gatewayManager);
  }

  return {
    status: 'updated',
    providerIds: [...nextAccounts.keys()],
    subjectHash,
    modelCount: usableCredentials.reduce((total, entry) => total + entry.runtimeModels.length, 0),
  };
}

export async function cleanupSub2ApiEmployeeSecret(providerId: string): Promise<void> {
  await deleteProviderSecret(providerId);
}
