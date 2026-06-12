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
