/**
 * DingTalk OAuth 2.0 Login Flow
 *
 * Implements OAuth 2.0 Authorization Code Grant for DingTalk enterprise internal apps.
 * Flow:
 *   1. Start local HTTP server on random port for callback
 *   2. Open DingTalk authorization URL in system browser
 *   3. User scans QR code / approves authorization
 *   4. DingTalk redirects to http://localhost:{port}/callback?code=xxx&state=xxx
 *   5. Exchange auth_code for access_token
 *   6. Fetch user profile using access_token
 *   7. Return user info and clean up
 *
 * All file I/O and network calls are async to avoid blocking the Electron main thread.
 */
import { createServer, type Server } from 'http';
import { randomUUID } from 'crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { shell } from 'electron';
import { proxyAwareFetch } from './proxy-fetch';
import { logger } from './logger';

// ── DingTalk App Configuration ────────────────────────────────

interface DingTalkOAuthConfig {
  clientId: string;
  clientSecret: string;
  callbackPort: number;
}

const DEFAULT_DINGTALK_CLIENT_ID = 'dingvrynfuxju0wsjaaj';
const DEFAULT_DINGTALK_CLIENT_SECRET = 'UDwL3jTR8-G02wm90ucDYwhkhaMDN8VooUKnEB-c7Zrvmtp6-NHKGLcw0vT0f3Jz';
const DEFAULT_DINGTALK_CALLBACK_PORT = 13211;
const LOCAL_ENV_FILES = ['.env.local', '.env'];
let localEnvCache: Record<string, string> | null = null;

function parseLocalEnv(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const equalsIndex = line.indexOf('=');
    if (equalsIndex <= 0) continue;

    const key = line.slice(0, equalsIndex).trim();
    let value = line.slice(equalsIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function getLocalEnv(): Record<string, string> {
  if (localEnvCache) return localEnvCache;

  localEnvCache = {};
  for (const filename of LOCAL_ENV_FILES) {
    const envPath = resolve(process.cwd(), filename);
    if (!existsSync(envPath)) continue;
    try {
      localEnvCache = {
        ...localEnvCache,
        ...parseLocalEnv(readFileSync(envPath, 'utf8')),
      };
    } catch (error) {
      logger.warn(`[DingTalkOAuth] Failed to read ${filename}:`, error);
    }
  }
  return localEnvCache;
}

function getEnv(name: string): string {
  return process.env[name]?.trim() || getLocalEnv()[name]?.trim() || '';
}

/** Same resolution as DingTalk OAuth (`process.env` then repo-root `.env.local` / `.env`). */
export function getLyclawEnvVariable(name: string): string {
  return getEnv(name);
}

function getDingTalkConfig(): DingTalkOAuthConfig {
  const clientId = getEnv('LYCLAW_DINGTALK_CLIENT_ID')
    || getEnv('DINGTALK_CLIENT_ID')
    || DEFAULT_DINGTALK_CLIENT_ID;
  const clientSecret = getEnv('LYCLAW_DINGTALK_CLIENT_SECRET')
    || getEnv('DINGTALK_CLIENT_SECRET')
    || DEFAULT_DINGTALK_CLIENT_SECRET;
  const callbackPort = Number.parseInt(
    getEnv('LYCLAW_DINGTALK_CALLBACK_PORT') || getEnv('DINGTALK_CALLBACK_PORT'),
    10,
  ) || DEFAULT_DINGTALK_CALLBACK_PORT;

  if (!clientSecret) {
    throw new Error('缺少钉钉应用密钥，请设置 LYCLAW_DINGTALK_CLIENT_SECRET');
  }

  return { clientId, clientSecret, callbackPort };
}

function getRedirectUri(config: DingTalkOAuthConfig): string {
  return `http://localhost:${config.callbackPort}/callback`;
}

// ── DingTalk API Endpoints ───────────────────────────────────

const DINGTALK_OAUTH_AUTHORIZE_URL = 'https://login.dingtalk.com/oauth2/auth';
const DINGTALK_GET_USER_ACCESS_TOKEN = 'https://api.dingtalk.com/v1.0/oauth2/userAccessToken';
const DINGTALK_GET_TOKEN_ENDPOINT = 'https://oapi.dingtalk.com/gettoken';
const DINGTALK_USERINFO_ENDPOINT = 'https://api.dingtalk.com/v1.0/contact/users/me';
const DINGTALK_USER_DETAIL_ENDPOINT = 'https://oapi.dingtalk.com/topapi/v2/user/get';

// ── Types ────────────────────────────────────────────────────

export interface DingTalkUserInfo {
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
}

export interface DingTalkLoginResult {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  user: DingTalkUserInfo;
}

export interface DingTalkLoginOptions {
  onQrUrl?: (url: string) => void;
  onStatus?: (status: string) => void;
  openExternal?: boolean;
}

export interface DingTalkLoginSession {
  authorizeUrl: string;
  result: Promise<DingTalkLoginResult>;
  cancel: () => void;
}

interface DingTalkErrorResponse {
  code: string;
  message: string;
  requestId: string;
}

// ── Helpers ──────────────────────────────────────────────────

function generateState(): string {
  return randomUUID().replace(/-/g, '');
}

function buildAuthorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(DINGTALK_OAUTH_AUTHORIZE_URL);
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', params.state);
  return url.toString();
}

function isDingTalkError(response: unknown): response is DingTalkErrorResponse {
  return (
    typeof response === 'object' &&
    response !== null &&
    'code' in response &&
    'message' in response
  );
}

// ── Core OAuth Flow ──────────────────────────────────────────

/**
 * Start DingTalk OAuth login flow.
 * Opens browser for user authorization, listens for callback, and returns user info.
 */
export async function loginDingTalkOAuth(
  options?: DingTalkLoginOptions,
): Promise<DingTalkLoginResult> {
  const session = startDingTalkOAuthSession({ ...options, openExternal: options?.openExternal ?? true });
  return await session.result;
}

export function startDingTalkOAuthSession(
  options?: DingTalkLoginOptions,
): DingTalkLoginSession {
  const config = getDingTalkConfig();
  const state = generateState();
  let callbackServer: Server | null = null;
  let callbackPromise: Promise<{ code: string; state: string }>;
  let cancelled = false;

  // Step 1: Start local HTTP server for callback
  const port = config.callbackPort;
  const redirectUri = getRedirectUri(config);

  logger.info(`[DingTalkOAuth] Starting callback server on port ${port}`);
  options?.onStatus?.('正在启动本地服务...');

  const callback = startCallbackServer(port, state);
  callbackServer = callback.server;
  callbackPromise = callback.promise;

  // Step 2: Build and open authorization URL
  const authorizeUrl = buildAuthorizeUrl({
    clientId: config.clientId,
    redirectUri,
    state,
  });

  logger.info(`[DingTalkOAuth] Opening authorization URL: ${authorizeUrl}`);
  options?.onStatus?.('正在打开钉钉授权页面...');
  options?.onQrUrl?.(authorizeUrl);

  const result = (async (): Promise<DingTalkLoginResult> => {
    if (options?.openExternal !== false) {
      try {
        await shell.openExternal(authorizeUrl);
      } catch (error) {
        if (callbackServer) {
          callbackServer.close();
        }
        logger.error('[DingTalkOAuth] Failed to open browser:', error);
        throw new Error('无法打开浏览器，请手动访问授权链接');
      }
    }

    // Step 3: Wait for callback
    options?.onStatus?.('等待用户授权...');
    let callbackResult: { code: string; state: string };
    try {
      callbackResult = await Promise.race([
        callbackPromise,
        timeoutPromise(5 * 60 * 1000), // 5 minutes timeout
      ]);
    } catch (error) {
      if (callbackServer) {
        callbackServer.close();
      }
      if (cancelled) {
        throw new Error('钉钉登录已取消');
      }
      if (error instanceof Error && error.message === 'timeout') {
        throw new Error('钉钉登录超时，请重试');
      }
      throw error;
    }

    // Validate state
    if (callbackResult.state !== state) {
      throw new Error('State 参数不匹配，可能存在安全风险');
    }

    logger.info('[DingTalkOAuth] Received authorization code');
    options?.onStatus?.('正在获取用户访问令牌...');

    // Step 4: Exchange code for user access token
    const userTokenResult = await getUserAccessToken({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      code: callbackResult.code,
    });

    logger.info('[DingTalkOAuth] Got user access token, fetching user info...');
    options?.onStatus?.('正在获取用户基本信息...');

    // Step 5: Get basic user info (unionId) using user access token
    const basicUserInfo = await fetchCurrentUser(userTokenResult.accessToken);

    logger.info('[DingTalkOAuth] Got unionId, fetching detailed profile...');
    options?.onStatus?.('正在获取用户详细信息...');

    // Step 6: Get app access_token for通讯录 API
    const appAccessToken = await getAppAccessToken(config);

    // Step 7: Get userid by unionId
    const userId = await getUserIdByUnionId(appAccessToken, basicUserInfo.unionId);

    // Step 8: Get detailed user profile
    const detailedUserInfo = await fetchUserDetail(appAccessToken, userId);

    // Use avatar from OAuth 2.0 interface if the detail API returns empty
    if (!detailedUserInfo.avatar && basicUserInfo.avatarUrl) {
      detailedUserInfo.avatar = basicUserInfo.avatarUrl;
    }

    logger.info(`[DingTalkOAuth] Login successful for user: ${detailedUserInfo.name} (${detailedUserInfo.userId})`);
    options?.onStatus?.('登录成功！');

    return {
      accessToken: userTokenResult.accessToken,
      expiresIn: userTokenResult.expiresIn,
      refreshToken: userTokenResult.refreshToken,
      user: detailedUserInfo,
    };
  })();

  return {
    authorizeUrl,
    result,
    cancel: () => {
      cancelled = true;
      if (callbackServer) {
        callbackServer.close();
      }
    },
  };
}

/**
 * Start a local HTTP server to receive the OAuth callback.
 */
function startCallbackServer(
  port: number,
  expectedState: string,
): { server: Server; promise: Promise<{ code: string; state: string }> } {
  const server = createServer();
  const promise = new Promise<{ code: string; state: string }>((resolve, reject) => {
    server.on('request', (req, res) => {
      if (!req.url?.startsWith('/callback')) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      const url = new URL(req.url, `http://localhost:${port}`);
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');
      const errorDescription = url.searchParams.get('error_description');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <html>
            <body style="font-family: system-ui; text-align: center; padding: 50px;">
              <h2>钉钉登录失败</h2>
              <p>${errorDescription || error}</p>
              <p>你可以关闭此页面，然后重试</p>
            </body>
          </html>
        `);
        server.close();
        reject(new Error(`钉钉授权失败: ${errorDescription || error}`));
        return;
      }

      if (!code || !state) {
        res.writeHead(400);
        res.end('Missing code or state parameter');
        return;
      }

      if (state !== expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <html>
            <body style="font-family: system-ui; text-align: center; padding: 50px;">
              <h2>钉钉登录失败</h2>
              <p>State 参数不匹配，可能存在安全风险</p>
              <p>你可以关闭此页面，然后重试</p>
            </body>
          </html>
        `);
        server.close();
        reject(new Error('State 参数不匹配，可能存在安全风险'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <html>
          <head>
            <script>
              setTimeout(function() { window.close(); }, 1500);
            </script>
          </head>
          <body style="font-family: system-ui; text-align: center; padding: 50px;">
            <h2>钉钉登录成功</h2>
            <p>授权已完成，页面将自动关闭</p>
            <p>LYClaw 正在获取你的用户信息...</p>
          </body>
        </html>
      `);

      server.close();
      resolve({ code, state });
    });

    server.on('error', reject);
  });
  server.listen(port, '127.0.0.1');
  return { server, promise };
}

/**
 * Exchange auth code for user access token using OAuth 2.0 flow.
 */
async function getUserAccessToken(params: {
  clientId: string;
  clientSecret: string;
  code: string;
}): Promise<{ accessToken: string; expiresIn: number; refreshToken: string; corpId: string }> {
  logger.info(`[DingTalkOAuth] Exchanging code for user access token. clientId=${params.clientId.substring(0, 5)}...`);

  const response = await proxyAwareFetch(DINGTALK_GET_USER_ACCESS_TOKEN, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      clientId: params.clientId,
      clientSecret: params.clientSecret,
      code: params.code,
      grantType: 'authorization_code',
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`获取用户访问令牌失败: ${text}`);
  }

  const data = await response.json() as {
    accessToken?: string;
    expiresIn?: number;
    refreshToken?: string;
    corpId?: string;
    errorMsg?: string;
    errorCode?: string;
  };

  if (data.errorCode || !data.accessToken) {
    throw new Error(`获取用户访问令牌失败: ${data.errorCode || 'unknown'} - ${data.errorMsg}`);
  }

  return {
    accessToken: data.accessToken,
    expiresIn: data.expiresIn || 7200,
    refreshToken: data.refreshToken || '',
    corpId: data.corpId || '',
  };
}

/**
 * Get current user info using user access token.
 */
async function fetchCurrentUser(accessToken: string): Promise<{ unionId: string; nick: string; email: string; avatarUrl: string }> {
  const response = await proxyAwareFetch(DINGTALK_USERINFO_ENDPOINT, {
    method: 'GET',
    headers: {
      'x-acs-dingtalk-access-token': accessToken,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`获取用户信息失败: ${text}`);
  }

  const data = await response.json() as {
    unionId?: string;
    nick?: string;
    email?: string;
    avatarUrl?: string;
    errorMsg?: string;
    errorCode?: string;
  };

  if (data.errorCode || !data.unionId) {
    throw new Error(`获取用户信息失败: ${data.errorCode || 'unknown'} - ${data.errorMsg}`);
  }

  return {
    unionId: data.unionId,
    nick: data.nick || '',
    email: data.email || '',
    avatarUrl: data.avatarUrl || '',
  };
}

/**
 * Get app access_token using clientId and clientSecret.
 */
async function getAppAccessToken(config: DingTalkOAuthConfig): Promise<string> {
  const url = `${DINGTALK_GET_TOKEN_ENDPOINT}?appkey=${encodeURIComponent(config.clientId)}&appsecret=${encodeURIComponent(config.clientSecret)}`;

  const response = await proxyAwareFetch(url, {
    method: 'GET',
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`获取应用 access_token 失败: ${text}`);
  }

  const data = await response.json() as {
    errcode: number;
    errmsg: string;
    access_token?: string;
    expires_in?: number;
  };

  if (data.errcode !== 0 || !data.access_token) {
    throw new Error(`获取应用 access_token 失败: ${data.errcode} - ${data.errmsg}`);
  }

  return data.access_token;
}

/**
 * Get userid by unionId.
 */
async function getUserIdByUnionId(appAccessToken: string, unionId: string): Promise<string> {
  const url = `https://oapi.dingtalk.com/topapi/user/getbyunionid?access_token=${encodeURIComponent(appAccessToken)}`;

  const response = await proxyAwareFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      unionid: unionId,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`获取 userid 失败: ${text}`);
  }

  const data = await response.json() as {
    errcode: number;
    errmsg: string;
    result?: {
      userid: string;
    };
  };

  if (data.errcode !== 0 || !data.result) {
    throw new Error(`获取 userid 失败: ${data.errcode} - ${data.errmsg}`);
  }

  return data.result.userid;
}

/**
 * Fetch detailed user profile using app access_token and userId.
 */
async function fetchUserDetail(appAccessToken: string, userId: string): Promise<DingTalkUserInfo> {
  const url = `${DINGTALK_USER_DETAIL_ENDPOINT}?access_token=${encodeURIComponent(appAccessToken)}`;

  const response = await proxyAwareFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      userid: userId,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`获取用户详情失败: ${text}`);
  }

  const data = await response.json() as {
    errcode: number;
    errmsg: string;
    result?: {
      userid: string;
      name: string;
      avatar: string;
      mobile: string;
      email: string;
      org_email: string;
      unionid: string;
      job_number: string;
      title: string;
      work_place: string;
      nickname: string;
      admin: boolean;
      boss: boolean;
      senior: boolean;
      active: boolean;
      disable_status: boolean;
      hide_mobile: boolean;
      real_authed: boolean;
      create_time: string;
      hired_date: number;
      login_id: string;
      manager_userid: string;
      exclusive_account: boolean;
      exclusive_account_type: string;
      exclusive_account_corp_id: string;
      exclusive_account_corp_name: string;
      dept_id_list: number[];
      role_list: Array<{ group_name: string; id: number; name: string }>;
      leader_in_dept: Array<{ dept_id: number; leader: boolean }>;
    };
  };

  if (data.errcode !== 0 || !data.result) {
    throw new Error(`获取用户详情失败: ${data.errcode} - ${data.errmsg}`);
  }

  logger.info(`[DingTalkOAuth] User detail raw data: ${JSON.stringify(data.result)}`);

  const r = data.result;
  return {
    unionId: r.unionid || '',
    name: r.name || '',
    avatar: r.avatar || '',
    mobile: r.mobile || '',
    email: r.email || '',
    orgEmail: r.org_email || '',
    jobNumber: r.job_number || '',
    title: r.title || '',
    workPlace: r.work_place || '',
    userId: r.userid || '',
    nickname: r.nickname || '',
    admin: r.admin || false,
    boss: r.boss || false,
    senior: r.senior || false,
    active: r.active || false,
    disableStatus: r.disable_status || false,
    hideMobile: r.hide_mobile || false,
    realAuthed: r.real_authed || false,
    createTime: r.create_time || '',
    hiredDate: r.hired_date || 0,
    loginId: r.login_id || '',
    managerUserId: r.manager_userid || '',
    exclusiveAccount: r.exclusive_account || false,
    exclusiveAccountType: r.exclusive_account_type || '',
    exclusiveAccountCorpId: r.exclusive_account_corp_id || '',
    exclusiveAccountCorpName: r.exclusive_account_corp_name || '',
    deptIdList: r.dept_id_list || [],
    roleList: r.role_list || [],
    leaderInDept: r.leader_in_dept || [],
  };
}

/**
 * Main login flow using OAuth 2.0.
 */
function timeoutPromise(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error('timeout')), ms);
  });
}
