/**
 * Resolve OpenClaw runtime provider key and full model ref for a provider account.
 * Mirrors electron/utils/provider-keys.ts and Agents page logic.
 */
import type { ProviderAccount } from '@/lib/providers';
import { LY_AUTO_PROVIDER_ID } from '@/lib/providers';

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
    const suffix = account.id.replace(/-/g, '').slice(0, 8);
    return `${account.vendorId}-${suffix}`;
  }

  if (account.vendorId === 'minimax-portal-cn') {
    return 'minimax-portal';
  }

  return account.vendorId;
}

function extractModelIdFromStoredModel(model: string): string {
  const trimmed = model.trim();
  const slash = trimmed.indexOf('/');
  return slash >= 0 ? trimmed.slice(slash + 1).trim() : trimmed;
}

export function resolveAccountModelRef(account: ProviderAccount): string | undefined {
  const model = account.model?.trim();
  if (!model) return undefined;

  const runtimeKey = resolveRuntimeProviderKey(account);
  const modelId = extractModelIdFromStoredModel(model);
  if (!modelId) return undefined;

  return `${runtimeKey}/${modelId}`;
}

export function normalizeStoredProviderModel(account: ProviderAccount): string | undefined {
  const model = account.model?.trim();
  if (!model) return undefined;
  return extractModelIdFromStoredModel(model) || undefined;
}

export function findProviderItemByModelRef<T extends { account: ProviderAccount }>(
  items: T[],
  modelRef: string | undefined,
): T | undefined {
  if (!modelRef) return undefined;
  const normalized = modelRef.trim();
  if (!normalized) return undefined;

  return items.find((item) => resolveAccountModelRef(item.account) === normalized)
    ?? items.find((item) => {
      const stored = item.account.model?.trim();
      if (!stored) return false;
      return extractModelIdFromStoredModel(stored) === extractModelIdFromStoredModel(normalized);
    });
}

export function isLyAutoModelRef(modelRef: string | undefined): boolean {
  return Boolean(modelRef?.startsWith(`${LY_AUTO_PROVIDER_ID}/`));
}
