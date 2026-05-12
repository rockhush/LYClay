/**
 * Single-tenant DingTalk: after OAuth login, optionally write OpenClaw dingtalk channel
 * credentials from env and refresh Gateway. BFF welcome is deferred until the workspace
 * is shown (renderer calls `POST /api/dingtalk/welcome/send`).
 */
import type { HostApiContext } from '../api/context';
import { scheduleGatewayChannelSaveRefresh } from './gateway-channel-refresh';
import { getLyclawEnvVariable } from './dingtalk-oauth';
import { logger } from './logger';
import { proxyAwareFetch } from './proxy-fetch';
import { readOpenClawConfig, saveChannelConfig } from './channel-config';
import { ensureDingTalkPluginInstalled } from './plugin-install';
import { assignChannelAccountToAgent, listAgentsSnapshot } from './agent-config';

const DEFAULT_ACCOUNT_ID = 'default';

/** Built-in defaults when env / `.env.local` are absent (e.g. packaged installs). Override via `LYCLAW_DINGTALK_BFF_*`. */
const DEFAULT_DINGTALK_BFF_BASE_URL = 'http://10.0.99.18:8788';
const DEFAULT_DINGTALK_BFF_API_KEY = 'lyclaw-dingtalk-bff-api-key';

/** True when env provides OpenClaw dingtalk channel client id/secret (any supported var name). */
export function hasDingTalkChannelAutoProvisionFromEnv(): boolean {
  return getDingTalkChannelCredentialsFromEnv() !== null;
}

function getDingTalkChannelCredentialsFromEnv(): { clientId: string; clientSecret: string } | null {
  const clientId = getLyclawEnvVariable('LYCLAW_DINGTALK_CHANNEL_CLIENT_ID').trim()
    || getLyclawEnvVariable('LYCLAW_DINGTALK_CLIENT_ID').trim()
    || getLyclawEnvVariable('DINGTALK_CLIENT_ID').trim();
  const clientSecret = getLyclawEnvVariable('LYCLAW_DINGTALK_CHANNEL_CLIENT_SECRET').trim()
    || getLyclawEnvVariable('LYCLAW_DINGTALK_CLIENT_SECRET').trim()
    || getLyclawEnvVariable('DINGTALK_CLIENT_SECRET').trim();
  if (!clientId || !clientSecret) {
    return null;
  }
  return { clientId, clientSecret };
}

function getBffWelcomeConfig(): { baseUrl: string; apiKey: string } | null {
  const baseUrlRaw = getLyclawEnvVariable('LYCLAW_DINGTALK_BFF_BASE_URL').trim();
  const apiKeyRaw = getLyclawEnvVariable('LYCLAW_DINGTALK_BFF_API_KEY').trim();
  const baseUrl = (baseUrlRaw || DEFAULT_DINGTALK_BFF_BASE_URL).replace(/\/$/, '');
  const apiKey = apiKeyRaw || DEFAULT_DINGTALK_BFF_API_KEY;
  if (!baseUrl || !apiKey) {
    return null;
  }
  return { baseUrl, apiKey };
}

async function dingtalkDefaultAccountMatchesEnv(
  clientId: string,
  clientSecret: string,
): Promise<boolean> {
  const config = await readOpenClawConfig();
  const section = config.channels?.dingtalk as Record<string, unknown> | undefined;
  if (!section) return false;
  const accounts = section.accounts as Record<string, Record<string, unknown>> | undefined;
  const acc = accounts?.[DEFAULT_ACCOUNT_ID] ?? section;
  const existingId = typeof acc?.clientId === 'string' ? acc.clientId.trim() : '';
  const existingSecret = typeof acc?.clientSecret === 'string' ? acc.clientSecret.trim() : '';
  return existingId === clientId && existingSecret === clientSecret;
}

/** Match channels route: default dingtalk account → agent `main` so inbound messages are handled. */
async function ensureDingTalkDefaultBoundToMain(): Promise<boolean> {
  const agents = await listAgentsSnapshot();
  if (!agents.agents?.some((entry) => entry.id === 'main')) {
    logger.info('[DingTalkAuto] Skip dingtalk→main bind: no agent "main"');
    return false;
  }
  const owner = agents.channelAccountOwners[`dingtalk:${DEFAULT_ACCOUNT_ID}`];
  if (owner === 'main') {
    return false;
  }
  await assignChannelAccountToAgent('main', 'dingtalk', DEFAULT_ACCOUNT_ID);
  logger.info('[DingTalkAuto] Bound dingtalk default account to agent main (previous owner: %s)', owner ?? 'unset');
  return true;
}

async function provisionDingTalkChannelFromEnv(ctx: HostApiContext): Promise<void> {
  const creds = getDingTalkChannelCredentialsFromEnv();
  if (!creds) {
    logger.info(
      `[DingTalkAuto] Skip channel auto-provision: set LYCLAW_DINGTALK_CHANNEL_CLIENT_ID + _SECRET, or reuse `
        + `LYCLAW_DINGTALK_CLIENT_* / DINGTALK_CLIENT_* (same as OAuth; cwd=${process.cwd()})`,
    );
    return;
  }
  let wroteConfig = false;
  if (await dingtalkDefaultAccountMatchesEnv(creds.clientId, creds.clientSecret)) {
    logger.info('[DingTalkAuto] Channel config already matches env; skip save');
  } else {
    const installResult = ensureDingTalkPluginInstalled();
    if (!installResult.installed) {
      logger.warn('[DingTalkAuto] DingTalk plugin not installed; skip channel auto-provision', installResult.warning);
      return;
    }
    await saveChannelConfig('dingtalk', {
      enabled: true,
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
    }, DEFAULT_ACCOUNT_ID);
    wroteConfig = true;
    logger.info('[DingTalkAuto] Wrote dingtalk channel from env');
  }

  const boundMain = await ensureDingTalkDefaultBoundToMain();
  if (wroteConfig || boundMain) {
    scheduleGatewayChannelSaveRefresh(ctx, 'dingtalk', 'dingtalk:autoProvisionFromEnv');
  }
}

/** POST BFF welcome for the given staff userId (called after workspace entry; no-op if not logged in / empty id). */
export async function sendDingTalkBffWelcomeForUserId(userId: string): Promise<void> {
  if (!userId.trim()) {
    logger.info('[DingTalkAuto] Skip BFF welcome: no staff userId (not logged in)');
    return;
  }
  const bff = getBffWelcomeConfig();
  if (!bff) {
    logger.info('[DingTalkAuto] Skip BFF welcome: missing BFF base URL and API key');
    return;
  }
  const url = `${bff.baseUrl}/v1/dingtalk/welcome`;
  const response = await proxyAwareFetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bff.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ user_id: userId }),
  });
  const text = await response.text();
  if (!response.ok) {
    logger.warn('[DingTalkAuto] BFF welcome failed', { status: response.status, body: text.slice(0, 500) });
    return;
  }
  logger.info('[DingTalkAuto] BFF welcome sent', { userId });
}

/**
 * After DingTalk OAuth user is persisted: provision channel + schedule gateway refresh only.
 * BFF welcome is sent later from the renderer when the post-login workspace is ready.
 */
export async function runDingTalkChannelProvisionAfterLogin(ctx: HostApiContext): Promise<void> {
  try {
    await provisionDingTalkChannelFromEnv(ctx);
  } catch (error) {
    logger.warn('[DingTalkAuto] Channel auto-provision failed:', error);
  }
}

/** @deprecated Use runDingTalkChannelProvisionAfterLogin — welcome is no longer sent here. */
export async function runDingTalkSingleTenantPostLogin(
  ctx: HostApiContext,
  _userId: string,
): Promise<void> {
  await runDingTalkChannelProvisionAfterLogin(ctx);
}
