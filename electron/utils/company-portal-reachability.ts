import { getReportingBaseUrl } from './reporting/config';

const PROBE_TIMEOUT_MS = 5_000;

/**
 * Returns true when the company portal base URL responds (any HTTP status).
 * Used before startup skill reinstall so offline users keep existing installs.
 */
export async function isCompanyPortalReachable(): Promise<boolean> {
  const baseUrl = getReportingBaseUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    const response = await fetch(baseUrl, {
      method: 'GET',
      signal: controller.signal,
      headers: { Accept: '*/*' },
    });
    return response.status > 0;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
