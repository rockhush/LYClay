/**
 * DingTalk Login API Routes
 *
 * Routes:
 *   POST /api/dingtalk/login   - Start DingTalk OAuth login flow
 *   GET  /api/dingtalk/user    - Get current logged-in user info
 *   POST /api/dingtalk/logout  - Logout and clear user data
 *   GET  /api/dingtalk/channel-auto-from-env - Whether env drives OpenClaw dingtalk auto-provision
 *   POST /api/dingtalk/welcome/send - BFF welcome after workspace (post-login)
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';
import {
  loginDingTalkOAuth,
  startDingTalkOAuthSession,
  type DingTalkLoginSession,
  type DingTalkUserInfo,
} from '../../utils/dingtalk-oauth';
import { getSetting, setSetting, type AppSettings } from '../../utils/store';
import { logger } from '../../utils/logger';
import {
  shouldWriteDingTalkUserToWorkspace,
  writeDingTalkUserToWorkspace,
  type DingTalkUserMinimal,
} from '../../utils/openclaw-workspace';
import {
  hasDingTalkChannelAutoProvisionFromEnv,
  runDingTalkChannelProvisionAfterLogin,
  sendDingTalkBffWelcomeForUserId,
} from '../../utils/dingtalk-auto-provision';

type DingTalkUserStore = NonNullable<AppSettings['dingtalkUser']>;
type LoginSessionRecord = {
  id: string;
  status: 'pending' | 'success' | 'error';
  statusMessage: string;
  user: DingTalkUserStore | null;
  error: string | null;
  session: DingTalkLoginSession;
};

let activeLoginSession: LoginSessionRecord | null = null;

function toWorkspaceUser(user: DingTalkUserInfo): DingTalkUserMinimal {
  return {
    name: user.name,
    userId: user.userId,
    unionId: user.unionId,
    email: user.email,
    mobile: user.mobile,
    orgEmail: user.orgEmail,
    jobNumber: user.jobNumber,
    title: user.title,
    workPlace: user.workPlace,
    nickname: user.nickname,
    admin: user.admin,
    boss: user.boss,
    senior: user.senior,
    active: user.active,
    disableStatus: user.disableStatus,
    hideMobile: user.hideMobile,
    realAuthed: user.realAuthed,
    createTime: user.createTime,
    hiredDate: user.hiredDate,
    loginId: user.loginId,
    managerUserId: user.managerUserId,
    exclusiveAccount: user.exclusiveAccount,
    exclusiveAccountType: user.exclusiveAccountType,
    exclusiveAccountCorpId: user.exclusiveAccountCorpId,
    exclusiveAccountCorpName: user.exclusiveAccountCorpName,
    deptIdList: user.deptIdList,
    roleList: user.roleList,
  };
}

async function syncDingTalkUserToWorkspaceIfNeeded(
  previous: DingTalkUserStore | null,
  oauthUser: DingTalkUserInfo,
): Promise<void> {
  const next = toUserStore(oauthUser);
  if (!shouldWriteDingTalkUserToWorkspace(previous, next)) {
    return;
  }
  try {
    await writeDingTalkUserToWorkspace(toWorkspaceUser(oauthUser));
  } catch (error) {
    logger.warn('[DingTalkAPI] Failed to sync user to workspace USER.md:', error);
  }
}

function toUserStore(user: DingTalkUserInfo): DingTalkUserStore {
  return {
    openId: '',
    unionId: user.unionId,
    name: user.name,
    avatar: user.avatar,
    email: user.email,
    mobile: user.mobile,
    orgEmail: user.orgEmail,
    jobNumber: user.jobNumber,
    title: user.title,
    workPlace: user.workPlace,
    userId: user.userId,
    nickname: user.nickname,
    admin: user.admin,
    boss: user.boss,
    senior: user.senior,
    active: user.active,
    disableStatus: user.disableStatus,
    hideMobile: user.hideMobile,
    realAuthed: user.realAuthed,
    createTime: user.createTime,
    hiredDate: user.hiredDate,
    loginId: user.loginId,
    managerUserId: user.managerUserId,
    exclusiveAccount: user.exclusiveAccount,
    exclusiveAccountType: user.exclusiveAccountType,
    exclusiveAccountCorpId: user.exclusiveAccountCorpId,
    exclusiveAccountCorpName: user.exclusiveAccountCorpName,
    deptIdList: user.deptIdList,
    roleList: user.roleList,
    leaderInDept: user.leaderInDept,
    departmentIds: user.deptIdList.map(String),
    leaderUserId: user.managerUserId,
    loginAt: new Date().toISOString(),
  };
}

export async function handleDingTalkRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: HostApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/dingtalk/login' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ force?: boolean } | undefined>(req);
      const force = body?.force === true;

      // Check if already logged in (unless force=true)
      if (!force) {
        const existingUser = await getSetting('dingtalkUser');
        if (existingUser) {
          sendJson(res, 200, {
            success: true,
            alreadyLoggedIn: true,
            user: existingUser,
          });
          return true;
        }
      }

      logger.info('[DingTalkAPI] Starting OAuth login flow');

      const previousUser = await getSetting('dingtalkUser');

      // Start OAuth flow
      const result = await loginDingTalkOAuth({
        onStatus: (status) => {
          logger.info(`[DingTalkAPI] Status: ${status}`);
        },
      });

      // Store user info in electron-store
      const userStore = toUserStore(result.user);

      await setSetting('dingtalkUser', userStore);
      await syncDingTalkUserToWorkspaceIfNeeded(previousUser, result.user);
      await runDingTalkChannelProvisionAfterLogin(ctx);

      logger.info('[DingTalkAPI] User info saved to electron-store');

      sendJson(res, 200, {
        success: true,
        user: userStore,
      });
    } catch (error) {
      logger.error('[DingTalkAPI] Login failed:', error);
      sendJson(res, 500, {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  if (url.pathname === '/api/dingtalk/login/start' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ force?: boolean } | undefined>(req);
      const force = body?.force === true;

      if (!force) {
        const existingUser = await getSetting('dingtalkUser');
        if (existingUser) {
          sendJson(res, 200, {
            success: true,
            alreadyLoggedIn: true,
            user: existingUser,
          });
          return true;
        }
      }

      activeLoginSession?.session.cancel();
      const id = randomUUID();
      const record: LoginSessionRecord = {
        id,
        status: 'pending',
        statusMessage: '正在打开钉钉授权页面...',
        user: null,
        error: null,
        session: startDingTalkOAuthSession({
          openExternal: false,
          onStatus: (status) => {
            if (activeLoginSession?.id === id) {
              activeLoginSession.statusMessage = status;
            }
            logger.info(`[DingTalkAPI] Status: ${status}`);
          },
        }),
      };
      activeLoginSession = record;

      void record.session.result
        .then(async (result) => {
          const previousUser = await getSetting('dingtalkUser');
          const userStore = toUserStore(result.user);
          await setSetting('dingtalkUser', userStore);
          await syncDingTalkUserToWorkspaceIfNeeded(previousUser, result.user);
          await runDingTalkChannelProvisionAfterLogin(ctx);
          if (activeLoginSession?.id === id) {
            activeLoginSession.status = 'success';
            activeLoginSession.statusMessage = '登录成功！';
            activeLoginSession.user = userStore;
          }
        })
        .catch((error) => {
          logger.error('[DingTalkAPI] Embedded login failed:', error);
          if (activeLoginSession?.id === id) {
            activeLoginSession.status = 'error';
            activeLoginSession.error = error instanceof Error ? error.message : String(error);
            activeLoginSession.statusMessage = '';
          }
        });

      sendJson(res, 200, {
        success: true,
        loginId: id,
        authorizeUrl: record.session.authorizeUrl,
      });
    } catch (error) {
      logger.error('[DingTalkAPI] Failed to start embedded login:', error);
      sendJson(res, 500, {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  if (url.pathname === '/api/dingtalk/login/status' && req.method === 'GET') {
    const loginId = url.searchParams.get('loginId');
    if (!loginId || activeLoginSession?.id !== loginId) {
      sendJson(res, 404, {
        success: false,
        status: 'expired',
        error: '登录会话已失效，请重试',
      });
      return true;
    }

    sendJson(res, 200, {
      success: activeLoginSession.status !== 'error',
      status: activeLoginSession.status,
      statusMessage: activeLoginSession.statusMessage,
      user: activeLoginSession.user,
      error: activeLoginSession.error,
    });
    return true;
  }

  if (url.pathname === '/api/dingtalk/user' && req.method === 'GET') {
    try {
      const user = await getSetting('dingtalkUser');
      sendJson(res, 200, {
        success: true,
        user: user || null,
      });
    } catch (error) {
      sendJson(res, 500, {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  if (url.pathname === '/api/dingtalk/channel-auto-from-env' && req.method === 'GET') {
    sendJson(res, 200, {
      success: true,
      active: hasDingTalkChannelAutoProvisionFromEnv(),
    });
    return true;
  }

  if (url.pathname === '/api/dingtalk/welcome/send' && req.method === 'POST') {
    try {
      const user = await getSetting('dingtalkUser');
      // Only send when a DingTalk staff session is persisted (no anonymous / logged-out calls).
      if (!user || !user.userId?.trim()) {
        sendJson(res, 200, { success: true, skipped: true, reason: 'not_logged_in' });
        return true;
      }
      await sendDingTalkBffWelcomeForUserId(user.userId.trim());
      sendJson(res, 200, { success: true });
    } catch (error) {
      logger.error('[DingTalkAPI] welcome/send failed:', error);
      sendJson(res, 500, {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  if (url.pathname === '/api/dingtalk/logout' && req.method === 'POST') {
    try {
      // Clear user info from electron-store
      await setSetting('dingtalkUser', null);
      activeLoginSession?.session.cancel();
      activeLoginSession = null;

      // Note: We do NOT remove USER.md content on logout,
      // as it may contain other user-edited content.
      // The LYClaw-marked section will be overwritten on next login.

      logger.info('[DingTalkAPI] User logged out');
      sendJson(res, 200, {
        success: true,
      });
    } catch (error) {
      logger.error('[DingTalkAPI] Logout failed:', error);
      sendJson(res, 500, {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  // OPTIONS is handled by the server middleware; no route-level handler needed.

  return false;
}
