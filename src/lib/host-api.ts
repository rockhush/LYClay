import { invokeIpc } from '@/lib/api-client';
import { trackUiEvent } from './telemetry';
import { normalizeAppError } from './error-model';

const HOST_API_PORT = 13210;
const HOST_API_BASE = `http://127.0.0.1:${HOST_API_PORT}`;

/** Cached Host API auth token, fetched once from the main process via IPC. */
let cachedHostApiToken: string | null = null;

async function getHostApiToken(): Promise<string> {
  if (cachedHostApiToken) return cachedHostApiToken;
  try {
    cachedHostApiToken = await invokeIpc<string>('hostapi:token');
  } catch {
    cachedHostApiToken = '';
  }
  return cachedHostApiToken ?? '';
}

type HostApiProxyResponse = {
  ok?: boolean;
  data?: {
    status?: number;
    ok?: boolean;
    json?: unknown;
    text?: string;
  };
  error?: { message?: string } | string;
  // backward compatibility fields
  success: boolean;
  status?: number;
  json?: unknown;
  text?: string;
};

type HostApiProxyData = {
  status?: number;
  ok?: boolean;
  json?: unknown;
  text?: string;
};

function headersToRecord(headers?: HeadersInit): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...headers };
}

async function parseResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const payload = await response.json() as { error?: string };
      if (payload?.error) {
        message = payload.error;
      }
    } catch {
      // ignore body parse failure
    }
    throw normalizeAppError(new Error(message), {
      source: 'browser-fallback',
      status: response.status,
    });
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return await response.json() as T;
}

function resolveProxyErrorMessage(error: HostApiProxyResponse['error']): string {
  return typeof error === 'string'
    ? error
    : (error?.message || 'Host API proxy request failed');
}

function parseUnifiedProxyResponse<T>(
  response: HostApiProxyResponse,
  path: string,
  method: string,
  startedAt: number,
): T {
  if (!response.ok) {
    throw new Error(resolveProxyErrorMessage(response.error));
  }
  const data: HostApiProxyData = response.data ?? {};
  trackUiEvent('hostapi.fetch', {
    path,
    method,
    source: 'ipc-proxy',
    durationMs: Date.now() - startedAt,
    status: data.status ?? 200,
  });

  // Check HTTP status code from the actual response
  if (data.ok === false || (typeof data.status === 'number' && data.status >= 400)) {
    let message = `HTTP ${data.status}`;
    if (data.json && typeof data.json === 'object' && 'error' in (data.json as Record<string, unknown>)) {
      const errorPayload = (data.json as Record<string, unknown>).error;
      if (typeof errorPayload === 'string') {
        message = errorPayload;
      } else if (errorPayload && typeof errorPayload === 'object') {
        const errorObj = errorPayload as Record<string, unknown>;
        const errorCode = typeof errorObj.code === 'string' ? errorObj.code : '';
        const errorMsg = typeof errorObj.message === 'string' ? errorObj.message : '';
        // Include both code and message so classifyMessage can match nginx error codes
        message = errorCode ? `${errorCode}: ${errorMsg}` : (errorMsg || message);
      }
    } else if (data.text) {
      message = data.text;
    }
    throw normalizeAppError(new Error(message), {
      source: 'ipc-proxy',
      status: data.status,
      path,
      method,
    });
  }

  if (data.status === 204) return undefined as T;
  if (data.json !== undefined) return data.json as T;
  return data.text as T;
}

function parseLegacyProxyResponse<T>(
  response: HostApiProxyResponse,
  path: string,
  method: string,
  startedAt: number,
): T {
  if (!response.success) {
    throw new Error(resolveProxyErrorMessage(response.error));
  }

  if (!response.ok) {
    const message = response.text
      || (typeof response.json === 'object' && response.json != null && 'error' in (response.json as Record<string, unknown>)
        ? String((response.json as Record<string, unknown>).error)
        : `HTTP ${response.status ?? 'unknown'}`);
    throw new Error(message);
  }

  trackUiEvent('hostapi.fetch', {
    path,
    method,
    source: 'ipc-proxy-legacy',
    durationMs: Date.now() - startedAt,
    status: response.status ?? 200,
  });

  if (response.status === 204) return undefined as T;
  if (response.json !== undefined) return response.json as T;
  return response.text as T;
}

function shouldFallbackToBrowser(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes('invalid ipc channel: hostapi:fetch')
    || normalized.includes("no handler registered for 'hostapi:fetch'")
    || normalized.includes('no handler registered for "hostapi:fetch"')
    || normalized.includes('no handler registered for hostapi:fetch')
    || normalized.includes('window is not defined');
}

function allowLocalhostFallback(): boolean {
  try {
    return window.localStorage.getItem('LYClaw:allow-localhost-fallback') === '1'
      || window.localStorage.getItem('clawx:allow-localhost-fallback') === '1';
  } catch {
    return false;
  }
}

export async function hostApiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const startedAt = Date.now();
  const method = init?.method || 'GET';
  // In Electron renderer, always proxy through main process to avoid CORS.
  try {
    const response = await invokeIpc<HostApiProxyResponse>('hostapi:fetch', {
      path,
      method,
      headers: headersToRecord(init?.headers),
      body: init?.body ?? null,
    });

    if (typeof response?.ok === 'boolean' && 'data' in response) {
      return parseUnifiedProxyResponse<T>(response, path, method, startedAt);
    }

    return parseLegacyProxyResponse<T>(response, path, method, startedAt);
  } catch (error) {
    const normalized = normalizeAppError(error, { source: 'ipc-proxy', path, method });
    const message = normalized.message;
    trackUiEvent('hostapi.fetch_error', {
      path,
      method,
      source: 'ipc-proxy',
      durationMs: Date.now() - startedAt,
      message,
      code: normalized.code,
    });
    if (!shouldFallbackToBrowser(message)) {
      throw normalized;
    }
    if (!allowLocalhostFallback()) {
      trackUiEvent('hostapi.fetch_error', {
        path,
        method,
        source: 'ipc-proxy',
        durationMs: Date.now() - startedAt,
        message: 'localhost fallback blocked by policy',
        code: 'CHANNEL_UNAVAILABLE',
      });
      throw normalized;
    }
  }

  // Browser-only fallback (non-Electron environments).
  const token = await getHostApiToken();
  const response = await fetch(`${HOST_API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      ...(init?.headers || {}),
    },
  });
  trackUiEvent('hostapi.fetch', {
    path,
    method,
    source: 'browser-fallback',
    durationMs: Date.now() - startedAt,
    status: response.status,
  });
  try {
    return await parseResponse<T>(response);
  } catch (error) {
    throw normalizeAppError(error, { source: 'browser-fallback', path, method });
  }
}

export function createHostEventSource(path = '/api/events'): EventSource {
  // EventSource does not support custom headers, so pass the auth token
  // as a query parameter. The server accepts both mechanisms.
  const separator = path.includes('?') ? '&' : '?';
  const tokenParam = `token=${encodeURIComponent(cachedHostApiToken ?? '')}`;
  return new EventSource(`${HOST_API_BASE}${path}${separator}${tokenParam}`);
}

export function getHostApiBase(): string {
  return HOST_API_BASE;
}
export interface DingTalkUserInfo {
  openId?: string;
  unionId: string;
  name: string;
  avatar: string;
  mobile: string;
  email: string;
  orgEmail: string;
  jobNumber: string;
  title: string;
  workPlace: string;
  userId: string;
  nickname: string;
  admin: boolean;
  boss: boolean;
  senior: boolean;
  active: boolean;
  disableStatus: boolean;
  hideMobile: boolean;
  realAuthed: boolean;
  createTime: string;
  hiredDate: number;
  loginId: string;
  managerUserId: string;
  exclusiveAccount: boolean;
  exclusiveAccountType: string;
  exclusiveAccountCorpId: string;
  exclusiveAccountCorpName: string;
  deptIdList: number[];
  roleList: Array<{ group_name: string; id: number; name: string }>;
  leaderInDept: Array<{ dept_id: number; leader: boolean }>;
  departmentIds?: string[];
  leaderUserId?: string;
  loginAt?: string;
}

export async function loginWithDingTalk(force = false): Promise<{ success: boolean; user: DingTalkUserInfo | null; alreadyLoggedIn?: boolean }> {
  return hostApiFetch<{ success: boolean; user: DingTalkUserInfo | null; alreadyLoggedIn?: boolean }>(
    '/api/dingtalk/login',
    { method: 'POST', body: JSON.stringify({ force }) },
  );
}

export async function getDingTalkUser(): Promise<{ success: boolean; user: DingTalkUserInfo | null }> {
  return hostApiFetch<{ success: boolean; user: DingTalkUserInfo | null }>('/api/dingtalk/user');
}

export async function logoutDingTalk(): Promise<{ success: boolean }> {
  return hostApiFetch<{ success: boolean }>('/api/dingtalk/logout', { method: 'POST' });
}

/** True when `.env` provides OpenClaw dingtalk channel credentials (auto-provision after login). */
export async function getDingTalkChannelAutoFromEnv(): Promise<{ success: boolean; active: boolean }> {
  return hostApiFetch<{ success: boolean; active: boolean }>('/api/dingtalk/channel-auto-from-env');
}

/** BFF single-chat welcome — only after DingTalk sign-in; no-op server-side if not logged in. */
export async function sendDingTalkWorkspaceWelcome(): Promise<{ success: boolean; skipped?: boolean }> {
  return hostApiFetch<{ success: boolean; skipped?: boolean }>('/api/dingtalk/welcome/send', { method: 'POST' });
}

export type DeviceAccessStatus = 'allowed' | 'blocked' | 'unconfigured' | 'error';

export interface DeviceAccessResult {
  success: boolean;
  status: DeviceAccessStatus;
  allowed: boolean;
  deviceId?: string;
  cached?: boolean;
  checkedAt?: string;
  expiresAt?: string;
  reason?: string;
  error?: string;
}

export async function checkDeviceAccess(force = false): Promise<DeviceAccessResult> {
  return hostApiFetch<DeviceAccessResult>('/api/app/device-access', {
    method: force ? 'POST' : 'GET',
  });
}

export type EmptyFinalDiagnosticResponse = {
  success: boolean;
  diagnostic: Record<string, unknown> | null;
  hasTrackedActiveRun?: boolean;
  error?: string;
};

export type SessionRecoveryResult =
  | {
      ok: true;
      recovered: true;
      sessionKey: string;
      previousStatus: string | null;
      nextStatus: string;
      removedLockPath: string | null;
      reason: 'stale-empty-final';
    }
  | {
      ok: true;
      recovered: false;
      sessionKey: string;
      reason: string;
      details?: Record<string, unknown>;
    }
  | {
      ok: false;
      error: string;
    };

export async function getEmptyFinalDiagnostic(sessionKey: string): Promise<EmptyFinalDiagnosticResponse> {
  return hostApiFetch<EmptyFinalDiagnosticResponse>(
    `/api/sessions/empty-final-diagnostic?sessionKey=${encodeURIComponent(sessionKey)}`,
  );
}

export type SessionBackendActivityResponse = {
  sessionKey: string;
  status: string | null;
  processing: boolean;
  hasTrackedUserRun: boolean;
  activeRunIds: string[];
};

export type GatewayBackgroundActivityResponse = {
  hasBackgroundProcessing: boolean;
  processingSessionKeys: string[];
};

export type SessionBackendActivityApiResponse = {
  success: boolean;
  session: SessionBackendActivityResponse;
  background: GatewayBackgroundActivityResponse;
  error?: string;
};

export async function getSessionBackendActivity(
  sessionKey: string,
): Promise<SessionBackendActivityApiResponse> {
  return hostApiFetch<SessionBackendActivityApiResponse>(
    `/api/sessions/backend-activity?sessionKey=${encodeURIComponent(sessionKey)}`,
  );
}

export async function recoverStaleSessionAfterEmptyFinal(sessionKey: string): Promise<{ success: boolean; result?: SessionRecoveryResult; error?: string }> {
  return hostApiFetch<{ success: boolean; result?: SessionRecoveryResult; error?: string }>(
    '/api/sessions/recover-stale',
    {
      method: 'POST',
      body: JSON.stringify({ sessionKey }),
    },
  );
}
