/**
 * DWS CLI authentication helper.
 *
 * DWS data-access APIs must be authenticated with the official DWS CLI OAuth
 * client. ClawX's DingTalk OAuth token is not interchangeable with that token.
 */

import { execFile, execSync, spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { promisify } from 'util';
import * as path from 'path';
import { getDwsCliPath, getDwsDir } from './dws-env-setup';
import { ensureDwsCliInstalled } from './dws-cli-installer';
import { logger } from './logger';

const execFileAsync = promisify(execFile);
const DEFAULT_DWS_CLIENT_ID = 'dingmbw5n9ktkkbbjv3g';

export interface DwsCliTokenAuthOptions {
  accessToken: string;
  clientId?: string;
  clientSecret?: string;
  verify?: boolean;
}

export interface DwsCliTokenAuthResult {
  success: boolean;
  authenticated: boolean;
  output: string;
  message?: string;
}

export interface DwsCliLoginUser {
  userId: string;
  unionId: string;
  name: string;
  jobNumber?: string;
  avatar?: string;
  corpId?: string;
  corpName?: string;
  email?: string;
  mobile?: string;
  raw?: unknown;
}

export interface DwsCliLoginResult {
  user: DwsCliLoginUser;
}

export interface DwsCliLoginSession {
  authorizeUrl: string;
  result: Promise<DwsCliLoginResult>;
  cancel: () => void;
}

interface DwsAppConfig {
  clientId?: string;
  clientSecret?: string;
  createdAt?: string;
  updatedAt?: string;
}

function getDwsAppJsonPath(): string {
  return path.join(getDwsDir(), 'app.json');
}

function readDwsAppConfig(): DwsAppConfig | null {
  try {
    const appJsonPath = getDwsAppJsonPath();
    if (!existsSync(appJsonPath)) return null;
    return JSON.parse(readFileSync(appJsonPath, 'utf-8')) as DwsAppConfig;
  } catch (error) {
    logger.warn('[DwsAuth] Failed to read existing DWS app.json:', error);
    return null;
  }
}

function resolveDwsClientConfig(existingConfig: DwsAppConfig | null, overrides?: {
  clientId?: string;
  clientSecret?: string;
}): Required<Pick<DwsAppConfig, 'clientId' | 'clientSecret'>> {
  return {
    clientId: overrides?.clientId?.trim() || existingConfig?.clientId?.trim() || DEFAULT_DWS_CLIENT_ID,
    clientSecret: overrides?.clientSecret?.trim() || existingConfig?.clientSecret?.trim() || '',
  };
}

export async function configureDwsCli(
  clientId: string,
  clientSecret: string,
): Promise<void> {
  logger.info('[DwsAuth] Configuring DWS CLI...');

  const dwsDir = getDwsDir();
  if (!existsSync(dwsDir)) {
    mkdirSync(dwsDir, { recursive: true });
  }

  const existingConfig = readDwsAppConfig();
  const now = new Date().toISOString();
  const config: DwsAppConfig = {
    ...existingConfig,
    clientId,
    clientSecret: clientSecret || '',
    createdAt: existingConfig?.createdAt || now,
    updatedAt: now,
  };

  writeFileSync(getDwsAppJsonPath(), JSON.stringify(config, null, 2), 'utf-8');
  logger.info('[DwsAuth] DWS CLI configured with clientId');
}

function stripAnsi(input: string): string {
  const escape = String.fromCharCode(27);
  return input.replace(new RegExp(`${escape}\\[[0-9;]*m`, 'g'), '');
}

function extractDingTalkAuthorizeUrl(output: string): string | null {
  const clean = stripAnsi(output);
  const match = clean.match(/https:\/\/login\.dingtalk\.com\/oauth2\/[^\s"'<>]+/);
  return match?.[0] ?? null;
}

function getStringValue(obj: unknown, keys: string[]): string {
  if (!obj || typeof obj !== 'object') return '';
  const record = obj as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return '';
}

function getPathStringValue(obj: unknown, pathKeys: string[]): string {
  let current = obj;
  for (const key of pathKeys) {
    if (!current || typeof current !== 'object') return '';
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' || typeof current === 'number' ? String(current).trim() : '';
}

function normalizeDwsLoginUser(raw: unknown): DwsCliLoginUser {
  const root = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const payload = Array.isArray(root.result) ? root.result[0] : root.result ?? root;
  const employee = payload && typeof payload === 'object'
    ? (payload as Record<string, unknown>).orgEmployeeModel
    : undefined;

  return {
    userId: getPathStringValue(payload, ['orgEmployeeModel', 'userId'])
      || getStringValue(payload, ['userId', 'userid', 'openId', 'openId']),
    unionId: getStringValue(payload, ['unionId', 'unionid']),
    name: getPathStringValue(payload, ['orgEmployeeModel', 'orgUserName'])
      || getStringValue(payload, ['name', 'nick', 'nickname', 'displayName'])
      || getStringValue(employee, ['orgUserName']),
    jobNumber: getPathStringValue(payload, ['orgEmployeeModel', 'jobNumber'])
      || getPathStringValue(payload, ['orgEmployeeModel', 'jobNo'])
      || getPathStringValue(payload, ['orgEmployeeModel', 'job_number'])
      || getPathStringValue(employee, ['jobNumber', 'jobNo', 'job_number', 'staffId'])
      || getStringValue(payload, ['jobNumber', 'jobNo', 'job_number', 'staffId']),
    avatar: getStringValue(payload, ['avatar', 'avatarUrl']),
    corpId: getPathStringValue(payload, ['orgEmployeeModel', 'corpId']) || getStringValue(payload, ['corpId']),
    corpName: getPathStringValue(payload, ['orgEmployeeModel', 'orgName']) || getStringValue(payload, ['corpName', 'orgName']),
    email: getStringValue(payload, ['email', 'orgAuthEmail']),
    mobile: getStringValue(payload, ['mobile', 'orgUserMobile']),
    raw,
  };
}

async function execDwsJsonCommand(args: string[]): Promise<unknown> {
  const dwsPath = getDwsCliPath();
  const result = await execFileAsync(dwsPath, args, {
    encoding: 'utf-8',
    timeout: 30_000,
    windowsHide: true,
    env: sanitizeDwsEnv(),
  });
  const stdout = typeof result === 'string'
    ? result
    : (result as { stdout?: string | Buffer }).stdout?.toString();
  return JSON.parse(stdout || '{}');
}

async function fetchDwsCurrentUser(): Promise<DwsCliLoginUser> {
  const raw = await execDwsJsonCommand(['contact', 'user', 'get-self', '--format', 'json']);
  return normalizeDwsLoginUser(raw);
}

function sanitizeDwsEnv(options?: { suppressBrowser?: boolean }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.HTTP_PROXY;
  delete env.HTTPS_PROXY;
  delete env.ALL_PROXY;
  delete env.http_proxy;
  delete env.https_proxy;
  delete env.all_proxy;
  if (options?.suppressBrowser) {
    env.BROWSER = process.platform === 'win32' ? 'cmd /c exit 0' : 'true';
  }
  return env;
}

/**
 * Start a DWS-managed OAuth login session. The returned URL is the official
 * DWS CLI DingTalk OAuth page; completing it creates DWS's own CLI login state.
 */
export async function startDwsCliLoginSession(): Promise<DwsCliLoginSession> {
  const installResult = await ensureDwsCliInstalled();
  if (!installResult.success) {
    throw new Error(`DWS CLI installation failed: ${installResult.error || 'unknown error'}`);
  }

  await configureDwsCli(DEFAULT_DWS_CLIENT_ID, '');

  const dwsPath = getDwsCliPath();
  if (!existsSync(dwsPath)) {
    throw new Error(`DWS CLI binary not found after installation: ${dwsPath}`);
  }

  const env = sanitizeDwsEnv({ suppressBrowser: true });
  let child: ChildProcessWithoutNullStreams | null = null;
  let settledUrl = false;
  let bufferedOutput = '';

  const resultPromise = new Promise<DwsCliLoginResult>((resolve, reject) => {
    child = spawn(dwsPath, ['auth', 'login', '--force', '--no-browser', '--format', 'json'], {
      windowsHide: true,
      env,
    });

    const onData = (chunk: Buffer | string) => {
      bufferedOutput += chunk.toString();
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`DWS login failed with exit code ${code}: ${stripAnsi(bufferedOutput).trim()}`));
        return;
      }
      void fetchDwsCurrentUser().then((user) => resolve({ user }), reject);
    });
  });

  const authorizeUrl = await new Promise<string>((resolve, reject) => {
    const deadline = setTimeout(() => {
      reject(new Error(`DWS login did not produce an authorization URL: ${stripAnsi(bufferedOutput).trim()}`));
    }, 15_000);

    const poll = setInterval(() => {
      const url = extractDingTalkAuthorizeUrl(bufferedOutput);
      if (!url || settledUrl) return;
      settledUrl = true;
      clearTimeout(deadline);
      clearInterval(poll);
      resolve(url);
    }, 100);

    resultPromise.catch((error) => {
      if (settledUrl) return;
      clearTimeout(deadline);
      clearInterval(poll);
      reject(error);
    });
  });

  return {
    authorizeUrl,
    result: resultPromise,
    cancel: () => {
      child?.kill();
    },
  };
}

export async function authenticateDwsCliWithToken(
  options: DwsCliTokenAuthOptions,
): Promise<DwsCliTokenAuthResult> {
  const accessToken = options.accessToken.trim();
  const existingConfig = readDwsAppConfig();
  const { clientId, clientSecret } = resolveDwsClientConfig(existingConfig, {
    clientId: options.clientId,
    clientSecret: options.clientSecret,
  });

  if (!accessToken) throw new Error('DWS token auth requires a non-empty access token');

  await configureDwsCli(clientId, clientSecret);

  const dwsPath = getDwsCliPath();
  const args = ['auth', 'login', '--token', accessToken, '--client-id', clientId, '--yes', '--format', 'json'];
  if (clientSecret) args.splice(args.indexOf('--yes'), 0, '--client-secret', clientSecret);

  const result = await execFileAsync(dwsPath, args, {
    encoding: 'utf-8',
    timeout: 30_000,
    windowsHide: true,
    env: { ...sanitizeDwsEnv(), DWS_ACCESS_TOKEN: accessToken },
  });
  const stdout = typeof result === 'string'
    ? result
    : (result as { stdout?: string | Buffer; stderr?: string | Buffer }).stdout?.toString();
  const stderr = typeof result === 'string'
    ? ''
    : (result as { stdout?: string | Buffer; stderr?: string | Buffer }).stderr?.toString();

  const output = `${stdout || ''}${stderr ? `\n${stderr}` : ''}`.trim();
  const authenticated = options.verify === false ? true : isDwsCliAuthenticated();
  return {
    success: authenticated,
    authenticated,
    output,
    message: authenticated ? 'DWS CLI authenticated' : 'DWS CLI token login completed but status is not authenticated',
  };
}

export function isDwsCliAuthenticated(): boolean {
  const dwsPath = getDwsCliPath();
  try {
    const output = execSync(`"${dwsPath}" auth status --format json`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: sanitizeDwsEnv(),
    });
    const status = JSON.parse(output);
    return status.authenticated === true && status.token_valid !== false;
  } catch {
    return false;
  }
}

export async function logoutDwsCli(): Promise<void> {
  const dwsPath = getDwsCliPath();
  logger.info('[DwsAuth] Logging out DWS CLI...');
  execSync(`"${dwsPath}" auth logout --yes`, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: sanitizeDwsEnv(),
  });
  logger.info('[DwsAuth] DWS CLI logged out successfully');
}
