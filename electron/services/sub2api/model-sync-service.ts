import type { GatewayManager } from '../../gateway/manager';
import type { DigitalEmployeePackageManifest } from '../../../shared/types/digital-employee';
import { getSetting } from '../../utils/store';
import { logger } from '../../utils/logger';
import { createSub2ApiClient } from './sub2api-client';
import { completeSub2ApiRuntimeModel, reconcileGlobalSub2ApiProviders } from '../../utils/openclaw-managed-models';
import {
  hashSub2ApiSubject,
  resolveDigitalEmployeeSub2ApiSubject,
  resolveGlobalSub2ApiSubject,
  type DigitalEmployeeSub2ApiSubject,
  type GlobalSub2ApiSubject,
} from '../../utils/sub2api-subject';
import {
  deleteDigitalEmployeeModelScope,
  readDigitalEmployeeModelScope,
  writeDigitalEmployeeModelScope,
  type DigitalEmployeeModelScope,
} from '../../utils/digital-employee-model-scope';
import { deleteProviderSecret, setProviderSecret } from '../secrets/secret-store';
import { syncDefaultProviderToRuntime, syncDeletedProviderToRuntime, syncSavedProviderToRuntime } from '../providers/provider-runtime-sync';
import { getOpenClawProviderKeyForType } from '../../utils/provider-keys';
import type { ProviderConfig } from '../../utils/secure-storage';
import {
  listSub2ApiSyncStatus,
  recordSub2ApiSyncFailure,
  recordSub2ApiSyncStarted,
  recordSub2ApiSyncSuccess,
  type Sub2ApiSyncStatusRecord,
} from './model-sync-store';

export type Sub2ApiSyncReason = 'startup' | 'dingtalk-login' | 'manual' | 'install' | 'update';

export type DigitalEmployeeSub2ApiSyncContext = {
  manifest: DigitalEmployeePackageManifest;
  marketEmployeeId: string | number;
  instanceId: string;
  agentId: string;
};

export type Sub2ApiSyncResult = {
  status: 'success' | 'failed' | 'skipped-disabled' | 'skipped-missing-config' | 'skipped-missing-subject';
  subjectHash?: string;
  modelCount?: number;
  errorCode?: string;
};

type Sub2ApiRuntimeConfig = {
  enabled: boolean;
  baseUrl?: string;
  adminApiKey?: string;
  timeoutMs?: number;
  allowedHosts?: string[];
};

const BUILT_IN_SUB2API_ENABLED = true;
const BUILT_IN_SUB2API_BASE_URL = 'http://10.0.2.77:8081';
const BUILT_IN_SUB2API_ADMIN_API_KEY = 'admin-5f747d46b63a463888d7a4941f0246d50912e06af6eab88d26c582d91c31d855';
const BUILT_IN_SUB2API_TIMEOUT_MS = 5000;
const BUILT_IN_SUB2API_ALLOW_HOSTS = ['10.0.2.77'];

function readBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  const normalized = value?.trim();
  if (!normalized) return fallback;
  return /^(1|true|yes)$/i.test(normalized);
}

function readSub2ApiConfig(): Sub2ApiRuntimeConfig {
  const enabled = readBooleanEnv(process.env.SUB2API_ENABLED, BUILT_IN_SUB2API_ENABLED);
  const baseUrl = process.env.SUB2API_BASE_URL?.trim() || BUILT_IN_SUB2API_BASE_URL;
  const adminApiKey = process.env.SUB2API_ADMIN_API_KEY?.trim() || BUILT_IN_SUB2API_ADMIN_API_KEY;
  const timeoutRaw = process.env.SUB2API_TIMEOUT_MS?.trim();
  const parsedTimeoutMs = timeoutRaw ? Number(timeoutRaw) : BUILT_IN_SUB2API_TIMEOUT_MS;
  const allowedHosts = process.env.SUB2API_ALLOW_HOSTS
    ?.split(',')
    .map((host) => host.trim())
    .filter(Boolean) ?? BUILT_IN_SUB2API_ALLOW_HOSTS;
  return {
    enabled,
    ...(baseUrl ? { baseUrl } : {}),
    ...(adminApiKey ? { adminApiKey } : {}),
    ...(Number.isFinite(parsedTimeoutMs) && parsedTimeoutMs > 0 ? { timeoutMs: parsedTimeoutMs } : {}),
    ...(allowedHosts.length ? { allowedHosts } : {}),
  };
}

function createConfiguredClient(config: Sub2ApiRuntimeConfig) {
  if (!config.enabled) return null;
  if (!config.baseUrl || !config.adminApiKey) return null;
  return createSub2ApiClient({
    baseUrl: config.baseUrl,
    adminApiKey: config.adminApiKey,
    timeoutMs: config.timeoutMs,
    allowedHosts: config.allowedHosts,
  });
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof (error as { code?: unknown }).code === 'string') {
    return (error as { code: string }).code;
  }
  return 'sync-failed';
}

async function safeRecord<T>(operation: () => Promise<T>): Promise<T | null> {
  try {
    return await operation();
  } catch {
    return null;
  }
}

function completedModelIds(models: Array<string | { modelId?: string; id?: string }>): string[] {
  return models.map((model) => {
    if (typeof model === 'string') return model.trim();
    return String(model.modelId ?? model.id ?? '').trim();
  }).filter(Boolean);
}

function toEmployeeModelScope(
  subject: DigitalEmployeeSub2ApiSubject,
  result: Awaited<ReturnType<ReturnType<typeof createSub2ApiClient>['fetchUserProviderByUsername']>>,
  now: string,
): { scope: DigitalEmployeeModelScope; apiKey: string; modelCount: number } | null {
  const credential = result.credentials.find((entry) => entry.models.length > 0);
  if (!credential) return null;
  const providerId = `sub2api-employee-${subject.instanceId}`;
  const runtimeProviderKey = getOpenClawProviderKeyForType('custom', providerId);
  const modelIds = completedModelIds(credential.models);
  if (modelIds.length === 0) return null;
  return {
    apiKey: credential.apiKey,
    modelCount: modelIds.length,
    scope: {
      schemaVersion: 1,
      managedBy: 'sub2api',
      scope: 'digitalEmployee',
      userNo: subject.userNo,
      source: subject.source,
      marketEmployeeId: subject.marketEmployeeId,
      packageId: subject.packageId,
      instanceId: subject.instanceId,
      agentId: subject.agentId,
      provider: {
        providerId,
        protocol: 'openai-completions',
        baseUrl: result.provider.baseUrl,
        apiKeyRef: `secret:${providerId}`,
      },
      models: credential.models.map((model) => completeSub2ApiRuntimeModel(model)).filter((model): model is Record<string, unknown> & { id: string; name: string } => Boolean(model)),
      defaultModel: `${runtimeProviderKey}/${modelIds[0]}`,
      lastSuccessAt: now,
      lastError: null,
    },
  };
}


function modelScopeToProviderConfig(scope: DigitalEmployeeModelScope): ProviderConfig {
  const modelIds = completedModelIds(scope.models);
  const firstModel = modelIds[0];
  return {
    id: scope.provider.providerId,
    name: 'LY-SUB2API',
    type: 'custom',
    baseUrl: scope.provider.baseUrl,
    apiProtocol: scope.provider.protocol,
    model: firstModel,
    fallbackModels: modelIds,
    runtimeModels: scope.models
      .map((model) => completeSub2ApiRuntimeModel(model))
      .filter((model): model is Record<string, unknown> & { id: string; name: string } => Boolean(model)),
    metadata: {
      managedBy: 'sub2api',
      scope: 'digitalEmployee',
      hiddenInProviderSettings: true,
      lastSuccessAt: scope.lastSuccessAt ?? undefined,
    },
    enabled: true,
    createdAt: scope.lastSuccessAt ?? new Date().toISOString(),
    updatedAt: scope.lastSuccessAt ?? new Date().toISOString(),
  };
}
async function recordStarted(scope: GlobalSub2ApiSubject | DigitalEmployeeSub2ApiSubject, subjectHash: string) {
  return await safeRecord(() => recordSub2ApiSyncStarted({
    scope: scope.scope,
    subjectHash,
    source: scope.source,
  }));
}

export async function syncGlobalSub2ApiModels(
  reason: Extract<Sub2ApiSyncReason, 'startup' | 'dingtalk-login' | 'manual'>,
  gatewayManager?: GatewayManager,
): Promise<Sub2ApiSyncResult> {
  const config = readSub2ApiConfig();
  if (!config.enabled) {
    logger.info(`[Sub2API] Global sync skipped reason=${reason} status=skipped-disabled`);
    return { status: 'skipped-disabled' };
  }

  const dingtalkUser = await getSetting('dingtalkUser');
  const subject = resolveGlobalSub2ApiSubject(dingtalkUser);
  if (!subject) {
    logger.info(`[Sub2API] Global sync skipped reason=${reason} status=skipped-missing-subject`);
    return { status: 'skipped-missing-subject' };
  }

  const client = createConfiguredClient(config);
  if (!client) {
    logger.info(`[Sub2API] Global sync skipped reason=${reason} status=skipped-missing-config`);
    return { status: 'skipped-missing-config' };
  }

  const subjectHash = hashSub2ApiSubject(subject.scope, subject.userNo);
  logger.info(`[Sub2API] Global sync started reason=${reason} subjectHash=${subjectHash} source=${subject.source}`);
  const started = await recordStarted(subject, subjectHash);
  try {
    const response = await client.fetchUserProviderByUsername(subject.userNo);
    const result = await reconcileGlobalSub2ApiProviders(subject, response.credentials, { gatewayManager });
    if (result.status === 'cleared-empty-models') {
      await safeRecord(() => recordSub2ApiSyncFailure({
        scope: subject.scope,
        subjectHash,
        source: subject.source,
        modelCount: 0,
        errorCode: 'empty-models',
        startedAt: started?.lastStartedAt,
      }));
      logger.warn(`[Sub2API] Global sync failed reason=${reason} subjectHash=${subjectHash} errorCode=empty-models`);
      return { status: 'failed', subjectHash, modelCount: 0, errorCode: 'empty-models' };
    }
    const defaultProviderId = result.providerIds[0];
    if (defaultProviderId) {
      await syncDefaultProviderToRuntime(defaultProviderId, gatewayManager);
    }
    await safeRecord(() => recordSub2ApiSyncSuccess({
      scope: subject.scope,
      subjectHash,
      source: subject.source,
      modelCount: result.modelCount,
      startedAt: started?.lastStartedAt,
    }));
    logger.info(`[Sub2API] Global sync succeeded reason=${reason} subjectHash=${subjectHash} modelCount=${result.modelCount}`);
    return { status: 'success', subjectHash, modelCount: result.modelCount };
  } catch (error) {
    const code = errorCode(error);
    await safeRecord(() => recordSub2ApiSyncFailure({
      scope: subject.scope,
      subjectHash,
      source: subject.source,
      modelCount: 0,
      errorCode: code,
      startedAt: started?.lastStartedAt,
    }));
    logger.warn(`[Sub2API] Global sync failed reason=${reason} subjectHash=${subjectHash} errorCode=${code}`);
    return { status: 'failed', subjectHash, modelCount: 0, errorCode: code };
  }
}

export async function syncDigitalEmployeeSub2ApiModels(
  context: DigitalEmployeeSub2ApiSyncContext,
  reason: Extract<Sub2ApiSyncReason, 'install' | 'update' | 'manual'>,
): Promise<Sub2ApiSyncResult> {
  void reason;
  const config = readSub2ApiConfig();
  if (!config.enabled) return { status: 'skipped-disabled' };
  const client = createConfiguredClient(config);
  if (!client) return { status: 'skipped-missing-config' };

  const subject = resolveDigitalEmployeeSub2ApiSubject(context);
  if (!subject) return { status: 'skipped-missing-subject' };

  const subjectHash = hashSub2ApiSubject(subject.scope, subject.userNo);
  const started = await recordStarted(subject, subjectHash);
  try {
    const response = await client.fetchUserProviderByUsername(subject.userNo);
    const now = new Date().toISOString();
    const scopeResult = toEmployeeModelScope(subject, response, now);
    if (!scopeResult) {
      await safeRecord(() => recordSub2ApiSyncFailure({
        scope: subject.scope,
        subjectHash,
        source: subject.source,
        modelCount: 0,
        errorCode: 'empty-models',
        startedAt: started?.lastStartedAt,
      }));
      return { status: 'failed', subjectHash, modelCount: 0, errorCode: 'empty-models' };
    }
    await setProviderSecret({
      type: 'api_key',
      accountId: scopeResult.scope.provider.providerId,
      apiKey: scopeResult.apiKey,
    });
    await writeDigitalEmployeeModelScope(scopeResult.scope);
    await syncSavedProviderToRuntime(modelScopeToProviderConfig(scopeResult.scope), scopeResult.apiKey);
    await safeRecord(() => recordSub2ApiSyncSuccess({
      scope: subject.scope,
      subjectHash,
      source: subject.source,
      modelCount: scopeResult.modelCount,
      startedAt: started?.lastStartedAt,
    }));
    return { status: 'success', subjectHash, modelCount: scopeResult.modelCount, defaultModel: scopeResult.scope.defaultModel ?? undefined };
  } catch (error) {
    const code = errorCode(error);
    await safeRecord(() => recordSub2ApiSyncFailure({
      scope: subject.scope,
      subjectHash,
      source: subject.source,
      modelCount: 0,
      errorCode: code,
      startedAt: started?.lastStartedAt,
    }));
    logger.warn(`[Sub2API] Digital employee sync failed reason=${reason} subjectHash=${subjectHash} errorCode=${code}`);
    return { status: 'failed', subjectHash, modelCount: 0, errorCode: code };
  }
}

export async function cleanupDigitalEmployeeSub2ApiModels(instanceId: string): Promise<void> {
  const scope = await readDigitalEmployeeModelScope(instanceId);
  if (scope?.provider?.providerId) {
    await syncDeletedProviderToRuntime({
      id: scope.provider.providerId,
      name: 'LY-SUB2API',
      type: 'custom',
      baseUrl: scope.provider.baseUrl,
      apiProtocol: scope.provider.protocol,
      model: completedModelIds(scope.models)[0],
      fallbackModels: completedModelIds(scope.models),
      runtimeModels: scope.models
        .map((model) => completeSub2ApiRuntimeModel(model))
        .filter((model): model is Record<string, unknown> & { id: string; name: string } => Boolean(model)),
      metadata: {
        managedBy: 'sub2api',
        scope: 'digitalEmployee',
        hiddenInProviderSettings: true,
      },
      enabled: true,
      createdAt: scope.lastSuccessAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, scope.provider.providerId);
    await deleteProviderSecret(scope.provider.providerId);
  }
  await deleteDigitalEmployeeModelScope(instanceId);
}

export async function getSub2ApiSyncStatus(): Promise<Sub2ApiSyncStatusRecord[]> {
  return await listSub2ApiSyncStatus();
}
