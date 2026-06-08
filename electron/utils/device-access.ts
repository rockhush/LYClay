import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { getDataDir } from './paths';
import { proxyAwareFetch } from './proxy-fetch';

export type DeviceAccessStatus = 'allowed' | 'blocked' | 'unconfigured' | 'error';
export type DeviceAccessOsType = 'windows' | 'mac';

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

type DeviceAccessCache = {
  allowed: boolean;
  status: 'allowed' | 'blocked';
  deviceId: string;
  checkedAt: string;
  expiresAt: string;
  reason?: string;
};

const DEFAULT_CACHE_TTL_MS = 0;
const DEFAULT_DEVICE_ACCESS_ENDPOINT = 'https://lyclawtoken.lingyiitech.com/api/check-token';
const DEFAULT_DEVICE_ACCESS_AUTH_TOKEN = '%i(uQ{q?}Wq_Hwyk[NhZtZ0d-xDJY_=+';
const DEVICE_ACCESS_REQUEST_TIMEOUT_MS = 10000;
const execFileAsync = promisify(execFile);

function getDeviceAccessEndpoint(): string {
  return process.env.CLAWX_DEVICE_ACCESS_URL?.trim() || DEFAULT_DEVICE_ACCESS_ENDPOINT;
}

function getDeviceAccessAuthToken(): string {
  return process.env.CLAWX_DEVICE_ACCESS_AUTH_TOKEN?.trim() || DEFAULT_DEVICE_ACCESS_AUTH_TOKEN;
}

function formatAuthorizationHeader(authToken: string): string {
  return authToken.toLowerCase().startsWith('bearer ') ? authToken : `Bearer ${authToken}`;
}

function getDeviceTokenOverride(): string {
  return process.env.CLAWX_DEVICE_ACCESS_DEVICE_TOKEN?.trim() || '';
}

function getDeviceGuidExeOverride(): string {
  return process.env.CLAWX_DEVICE_GUID_EXE_PATH?.trim() || '';
}

function getDeviceAccessOsTypeOverride(): DeviceAccessOsType | '' {
  const raw = process.env.CLAWX_DEVICE_ACCESS_OS_TYPE?.trim().toLowerCase();
  if (raw === 'windows' || raw === 'mac') return raw;
  return '';
}

function getCacheTtlMs(): number {
  const raw = process.env.CLAWX_DEVICE_ACCESS_CACHE_TTL_MS?.trim();
  if (!raw) return DEFAULT_CACHE_TTL_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : DEFAULT_CACHE_TTL_MS;
}

function shouldFailOpen(): boolean {
  return process.env.CLAWX_DEVICE_ACCESS_FAIL_OPEN === '1';
}

function cachePath(): string {
  return join(getDataDir(), 'device-access-cache.json');
}

async function readCache(deviceId: string): Promise<DeviceAccessResult | null> {
  try {
    const raw = await readFile(cachePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<DeviceAccessCache>;
    if (
      parsed.deviceId !== deviceId ||
      typeof parsed.allowed !== 'boolean' ||
      (parsed.status !== 'allowed' && parsed.status !== 'blocked') ||
      typeof parsed.expiresAt !== 'string'
    ) {
      return null;
    }

    if (Date.parse(parsed.expiresAt) <= Date.now()) {
      return null;
    }

    return {
      success: true,
      status: parsed.status,
      allowed: parsed.allowed,
      deviceId,
      cached: true,
      checkedAt: parsed.checkedAt,
      expiresAt: parsed.expiresAt,
      reason: parsed.reason,
    };
  } catch {
    return null;
  }
}

async function writeCache(result: DeviceAccessResult): Promise<void> {
  if (result.status !== 'allowed' && result.status !== 'blocked') return;
  if (!result.deviceId || !result.checkedAt || !result.expiresAt) return;

  const payload: DeviceAccessCache = {
    allowed: result.allowed,
    status: result.status,
    deviceId: result.deviceId,
    checkedAt: result.checkedAt,
    expiresAt: result.expiresAt,
    reason: result.reason,
  };
  await mkdir(getDataDir(), { recursive: true });
  await writeFile(cachePath(), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function pickBoolean(payload: unknown): boolean | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  for (const key of ['exists', 'allowed', 'isCompanyDevice', 'companyDevice', 'authorized']) {
    if (typeof record[key] === 'boolean') return record[key];
  }
  if (record.data && typeof record.data === 'object') {
    return pickBoolean(record.data);
  }
  return null;
}

function pickReason(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  for (const key of ['reason', 'message', 'error']) {
    if (typeof record[key] === 'string' && record[key].trim()) return record[key];
  }
  if (record.data && typeof record.data === 'object') {
    return pickReason(record.data);
  }
  return undefined;
}

function formatDeviceAccessHttpError(status: number, payload: unknown): string {
  const backendReason = pickReason(payload);
  if (status === 400) {
    return '设备校验请求参数异常，请联系 IT 处理';
  }
  if (status === 401 || status === 403) {
    return '设备校验服务授权失败，请联系 IT 检查授权配置';
  }
  if (status === 404) {
    return '设备校验服务地址不可用，请联系 IT 处理';
  }
  if (status === 405) {
    return '设备校验服务请求方式异常，请联系 IT 处理';
  }
  if (status >= 500) {
    return '设备校验服务暂时不可用，请稍后重试或联系 IT';
  }
  return backendReason || `设备校验服务返回异常状态：${status}`;
}

function parseDeviceGuidOutput(output: string): string {
  const match = output.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (!match) {
    throw new Error('GetDeviceGUID.exe did not print a GUID token');
  }
  return match[0].toLowerCase();
}

function parseMacSerialNumberOutput(output: string): string {
  const ioregMatch = output.match(/"IOPlatformSerialNumber"\s*=\s*"([^"]+)"/);
  if (ioregMatch?.[1]?.trim()) return ioregMatch[1].trim();

  const profilerMatch = output.match(/Serial Number(?: \(system\))?:\s*(\S+)/i);
  if (profilerMatch?.[1]?.trim()) return profilerMatch[1].trim();

  throw new Error('Unable to read macOS serial number');
}

function getDeviceAccessOsType(): DeviceAccessOsType {
  const override = getDeviceAccessOsTypeOverride();
  if (override) return override;
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'mac';
  throw new Error(`Device access is not supported on ${process.platform}`);
}

function resolveDeviceGuidExePath(): string {
  const override = getDeviceGuidExeOverride();
  if (override) return override;

  const devPath = join(process.cwd(), 'resources', 'device-guid', 'win32', 'GetDeviceGUID.exe');
  if (existsSync(devPath)) return devPath;

  return join(process.resourcesPath, 'device-guid', 'win32', 'GetDeviceGUID.exe');
}

async function getWindowsDeviceAccessToken(): Promise<string> {
  const exePath = resolveDeviceGuidExePath();
  if (!existsSync(exePath)) {
    throw new Error(`GetDeviceGUID.exe not found: ${exePath}`);
  }

  const { stdout, stderr } = await execFileAsync(exePath, [], {
    cwd: dirname(exePath),
    timeout: 10000,
    windowsHide: true,
  });
  const token = parseDeviceGuidOutput(`${stdout}\n${stderr}`);
  console.info('[device-access] GetDeviceGUID.exe returned token', { token });
  return token;
}

async function getMacDeviceAccessToken(): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
      timeout: 10000,
      windowsHide: true,
    });
    const token = parseMacSerialNumberOutput(`${stdout}\n${stderr}`);
    console.info('[device-access] ioreg returned macOS serial number', { token });
    return token;
  } catch (error) {
    const { stdout, stderr } = await execFileAsync('/usr/sbin/system_profiler', ['SPHardwareDataType'], {
      timeout: 10000,
      windowsHide: true,
    });
    const token = parseMacSerialNumberOutput(`${stdout}\n${stderr}`);
    console.info('[device-access] system_profiler returned macOS serial number', {
      token,
      fallbackReason: error instanceof Error ? error.message : String(error),
    });
    return token;
  }
}

async function getDeviceAccessToken(osType: DeviceAccessOsType): Promise<string> {
  const override = getDeviceTokenOverride();
  if (override) {
    console.info('[device-access] using token override from CLAWX_DEVICE_ACCESS_DEVICE_TOKEN');
    return override;
  }

  return osType === 'windows' ? getWindowsDeviceAccessToken() : getMacDeviceAccessToken();
}

async function queryTokenExists(endpoint: string, authToken: string, token: string, osType: DeviceAccessOsType): Promise<{
  exists: boolean;
  reason?: string;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEVICE_ACCESS_REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await proxyAwareFetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: formatAuthorizationHeader(authToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ token, os_type: osType }),
      signal: controller.signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('设备校验接口请求超时，请检查网络后重试', { cause: error });
    }
    throw new Error(`设备校验接口连接失败，请检查网络后重试${message ? `（${message}）` : ''}`, { cause: error });
  } finally {
    clearTimeout(timer);
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(formatDeviceAccessHttpError(response.status, payload));
  }

  const exists = pickBoolean(payload);
  if (exists == null) {
    throw new Error('Device access service did not return an exists flag');
  }

  return {
    exists,
    reason: pickReason(payload),
  };
}

export async function checkDeviceAccess(options: { force?: boolean } = {}): Promise<DeviceAccessResult> {
  const endpoint = getDeviceAccessEndpoint();
  const authToken = getDeviceAccessAuthToken();
  let osType: DeviceAccessOsType;
  let token: string;
  try {
    osType = getDeviceAccessOsType();
    token = await getDeviceAccessToken(osType);
  } catch (error) {
    return {
      success: false,
      status: 'error',
      allowed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const deviceId = `${osType}:${token}`;
  if (!options.force) {
    const cacheTtlMs = getCacheTtlMs();
    if (cacheTtlMs > 0) {
      const cached = await readCache(deviceId);
      if (cached) return cached;
    }
  }

  const checkedAtMs = Date.now();
  const checkedAt = new Date(checkedAtMs).toISOString();
  const cacheTtlMs = getCacheTtlMs();
  const expiresAt = new Date(checkedAtMs + Math.max(0, cacheTtlMs)).toISOString();

  try {
    console.info('[device-access] checking device token', { token, osType });
    const queryResult = await queryTokenExists(endpoint, authToken, token, osType);
    console.info('[device-access] device token result', {
      token,
      osType,
      exists: queryResult.exists,
      reason: queryResult.reason,
    });

    const allowed = queryResult.exists;
    const result: DeviceAccessResult = {
      success: true,
      status: allowed ? 'allowed' : 'blocked',
      allowed,
      deviceId,
      cached: false,
      checkedAt,
      expiresAt,
      reason: queryResult.reason || (allowed ? 'Token exists' : 'Token does not exist'),
    };
    if (cacheTtlMs > 0) {
      await writeCache(result);
    }
    return result;
  } catch (error) {
    if (cacheTtlMs > 0) {
      const cached = await readCache(deviceId);
      if (cached?.allowed) {
        return {
          ...cached,
          reason: cached.reason || 'Using cached company device authorization.',
        };
      }
    }
    if (shouldFailOpen()) {
      return {
        success: true,
        status: 'error',
        allowed: true,
        deviceId,
        error: error instanceof Error ? error.message : String(error),
        reason: 'Device access check failed open by configuration.',
      };
    }
    return {
      success: false,
      status: 'error',
      allowed: false,
      deviceId,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export const deviceAccessInternals = {
  formatDeviceAccessHttpError,
  formatAuthorizationHeader,
  parseDeviceGuidOutput,
  parseMacSerialNumberOutput,
  resolveDeviceGuidExePath,
};
