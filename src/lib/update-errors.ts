/** User-facing message when update endpoints are unreachable (off intranet). */
export const UPDATE_INTRANET_REQUIRED_MESSAGE = '请使用内网';

const INTRANET_ERROR_PATTERNS = [
  'unexpected token',
  'is not valid json',
  'intranet_required',
  '请使用内网',
  'network',
  'fetch failed',
  'enotfound',
  'econnrefused',
  'etimedout',
  'abort',
  'empty response',
  'file too small',
  'download failed',
  'http error',
  'check update failed',
] as const;

export function isUpdateIntranetOrNetworkError(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) return false;
  return INTRANET_ERROR_PATTERNS.some((pattern) => normalized.includes(pattern));
}

export function formatUpdateFriendlyError(message: string): string {
  if (isUpdateIntranetOrNetworkError(message)) {
    return UPDATE_INTRANET_REQUIRED_MESSAGE;
  }
  return message;
}

export function isSkillNotInMarketplaceError(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) return false;
  return /company api error:\s*404\b/.test(normalized);
}

export function isSkillRateLimitedError(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) return false;
  return /company api error:\s*429\b/.test(normalized);
}

/** Maps raw batch-update failures to user-facing skill toasts only. */
export function formatSkillBatchUpdateFailureReason(
  message: string,
  labels: {
    skillNotInMarketplace: string;
    rateLimited: string;
    useIntranet: string;
  },
): string {
  const trimmed = message.trim();
  if (!trimmed) return '';

  if (isSkillNotInMarketplaceError(trimmed)) {
    return labels.skillNotInMarketplace;
  }

  if (isSkillRateLimitedError(trimmed)) {
    return labels.rateLimited;
  }

  if (isUpdateIntranetOrNetworkError(trimmed)) {
    return labels.useIntranet;
  }

  return trimmed;
}
