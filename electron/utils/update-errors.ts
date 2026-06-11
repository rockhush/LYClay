/** User-facing message when update endpoints are unreachable (off intranet). */
export const UPDATE_INTRANET_REQUIRED_MESSAGE = '请使用内网';

const INTRANET_ERROR = 'INTRANET_REQUIRED';

export function createIntranetRequiredError(): Error {
  return new Error(INTRANET_ERROR);
}

export function isUpdateIntranetOrNetworkError(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized.includes('intranet_required')
    || normalized.includes('unexpected token')
    || normalized.includes('is not valid json')
    || normalized.includes('请使用内网')
    || normalized.includes('network')
    || normalized.includes('fetch failed')
    || normalized.includes('enotfound')
    || normalized.includes('econnrefused')
    || normalized.includes('etimedout')
    || normalized.includes('abort')
    || normalized.includes('empty response')
    || normalized.includes('file too small')
    || normalized.includes('download failed')
    || normalized.includes('http error')
    || normalized.includes('check update failed')
  );
}

export function formatUpdateFriendlyError(message: string): string {
  if (isUpdateIntranetOrNetworkError(message)) {
    return UPDATE_INTRANET_REQUIRED_MESSAGE;
  }
  return message;
}

export function parseCheckUpdateResponseBody(raw: string): {
  need_update: boolean;
  latest_version: string;
  changelog: string;
  download_url: string;
} {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith('<') || trimmed.startsWith('<!')) {
    throw createIntranetRequiredError();
  }

  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    throw createIntranetRequiredError();
  }

  if (!data || typeof data !== 'object' || typeof (data as { need_update?: unknown }).need_update !== 'boolean') {
    throw createIntranetRequiredError();
  }

  const parsed = data as {
    need_update: boolean;
    latest_version?: string;
    changelog?: string;
    download_url?: string;
  };

  if (parsed.need_update && !parsed.latest_version?.trim()) {
    throw createIntranetRequiredError();
  }

  return {
    need_update: parsed.need_update,
    latest_version: parsed.latest_version?.trim() ?? '',
    changelog: parsed.changelog ?? '',
    download_url: parsed.download_url?.trim() ?? '',
  };
}
