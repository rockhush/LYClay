/**
 * Resolve OpenClaw runtime provider key and full model ref for a provider account.
 * Mirrors electron/utils/provider-keys.ts and Agents page logic.
 */
import type { ProviderAccount } from '@/lib/providers';
import { LY_AUTO_PROVIDER_ID } from '@/lib/providers';

export type ProviderModelRefOption = {
  modelId: string;
  modelRef: string;
  label: string;
};

function stableProviderSuffix(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function getSub2ApiRuntimeSuffix(providerId: string): string | null {
  if (providerId.startsWith('sub2api-employee-')) {
    return `sub2e${stableProviderSuffix(providerId)}`;
  }
  if (providerId.startsWith('sub2api-global-')) {
    return `sub2g${stableProviderSuffix(providerId)}`;
  }
  return null;
}

export function resolveRuntimeProviderKey(account: ProviderAccount): string {
  if (account.authMode === 'oauth_browser') {
    if (account.vendorId === 'google') return 'google-gemini-cli';
    if (account.vendorId === 'openai') return 'openai-codex';
  }

  if (account.vendorId === 'custom' || account.vendorId === 'ollama') {
    const prefix = `${account.vendorId}-`;
    if (account.id.startsWith(prefix)) {
      const tail = account.id.slice(prefix.length);
      if (tail.length >= 1 && !tail.includes('-')) {
        return account.id;
      }
    }
    const sub2ApiSuffix = getSub2ApiRuntimeSuffix(account.id);
    if (sub2ApiSuffix) {
      return `${account.vendorId}-${sub2ApiSuffix}`;
    }
    const suffix = account.id.replace(/-/g, '').slice(0, 8);
    return `${account.vendorId}-${suffix}`;
  }

  if (account.vendorId === 'minimax-portal-cn') {
    return 'minimax-portal';
  }

  return account.vendorId;
}

export function extractModelIdFromModelRef(model: string): string {
  const trimmed = model.trim();
  const slash = trimmed.indexOf('/');
  return slash >= 0 ? trimmed.slice(slash + 1).trim() : trimmed;
}

export function resolveAccountModelRef(account: ProviderAccount): string | undefined {
  const model = account.model?.trim();
  if (!model) return undefined;

  const runtimeKey = resolveRuntimeProviderKey(account);
  const modelId = extractModelIdFromModelRef(model);
  if (!modelId) return undefined;

  return `${runtimeKey}/${modelId}`;
}

export function normalizeStoredProviderModel(account: ProviderAccount): string | undefined {
  const model = account.model?.trim();
  if (!model) return undefined;
  return extractModelIdFromModelRef(model) || undefined;
}

function isSub2ApiManagedAccount(account: ProviderAccount): boolean {
  return account.metadata?.managedBy === 'sub2api';
}

function pushModelRefOption(
  options: ProviderModelRefOption[],
  seen: Set<string>,
  runtimeKey: string,
  modelId: string | undefined,
  label?: string,
): void {
  const normalizedModelId = modelId?.trim();
  if (!normalizedModelId || seen.has(normalizedModelId)) return;
  seen.add(normalizedModelId);
  options.push({
    modelId: normalizedModelId,
    modelRef: `${runtimeKey}/${normalizedModelId}`,
    label: label?.trim() || normalizedModelId,
  });
}

export function resolveAccountModelRefs(account: ProviderAccount): ProviderModelRefOption[] {
  const runtimeKey = resolveRuntimeProviderKey(account);
  const options: ProviderModelRefOption[] = [];
  const seen = new Set<string>();

  if (isSub2ApiManagedAccount(account)) {
    for (const runtimeModel of account.runtimeModels ?? []) {
      pushModelRefOption(
        options,
        seen,
        runtimeKey,
        extractModelIdFromModelRef(runtimeModel.id),
        typeof runtimeModel.name === 'string' ? runtimeModel.name : undefined,
      );
    }
    pushModelRefOption(options, seen, runtimeKey, normalizeStoredProviderModel(account), account.label);
    for (const fallbackModel of account.fallbackModels ?? []) {
      pushModelRefOption(options, seen, runtimeKey, extractModelIdFromModelRef(fallbackModel));
    }
    return options;
  }

  const modelId = normalizeStoredProviderModel(account);
  if (modelId) {
    pushModelRefOption(options, seen, runtimeKey, modelId, account.label);
  }
  return options;
}

export function findProviderItemByModelRef<T extends { account: ProviderAccount }>(
  items: T[],
  modelRef: string | undefined,
): T | undefined {
  if (!modelRef) return undefined;
  const normalized = modelRef.trim();
  if (!normalized) return undefined;

  return items.find((item) => resolveAccountModelRefs(item.account).some((model) => model.modelRef === normalized))
    ?? items.find((item) => {
      const stored = item.account.model?.trim();
      if (!stored) return false;
      return extractModelIdFromModelRef(stored) === extractModelIdFromModelRef(normalized);
    });
}

export function isLyAutoModelRef(modelRef: string | undefined): boolean {
  return Boolean(modelRef?.startsWith(`${LY_AUTO_PROVIDER_ID}/`));
}