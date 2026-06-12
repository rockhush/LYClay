/**
 * Shared DingTalk bot provisioning: after OAuth login, ensure a managed OpenClaw
 * dingtalk channel account exists, then create a user-scoped binding/session key.
 * BFF welcome is deferred until the workspace is shown.
 *
 * Also auto-creates a dedicated "dingtalk" agent with channel-specific
 * workspace instructions so DingTalk replies contain only final answers
 * (no intermediate process narration).
 */
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import type { HostApiContext } from '../api/context';
import { scheduleGatewayChannelSaveRefresh } from './gateway-channel-refresh';
import { getLyclawEnvVariable, type DingTalkUserInfo } from './dingtalk-oauth';
import { logger } from './logger';
import { proxyAwareFetch } from './proxy-fetch';
import { readOpenClawConfig, saveChannelConfig } from './channel-config';
import { ensureDingTalkPluginInstalled } from './plugin-install';
import { assignChannelAccountToAgent, ensureAgentConfigEntry } from './agent-config';
import { expandPath } from './paths';
import {
  buildDingTalkBindingId,
  buildDingTalkSingleChatSessionKey,
  getDingTalkUserBinding,
  OFFICIAL_DINGTALK_ACCOUNT_ID,
  upsertDingTalkUserBinding,
  type DingTalkUserBinding,
} from './dingtalk-user-bindings';

const DEFAULT_ACCOUNT_ID = 'default';
export const DINGTALK_DEDICATED_AGENT_ID = 'dingtalk';
const ENABLE_DINGTALK_AUTO_INTEGRATION = false;

/** Built-in defaults when env / `.env.local` are absent (e.g. packaged installs). Override via `LYCLAW_DINGTALK_BFF_*`. */
const DEFAULT_DINGTALK_BFF_BASE_URL = 'http://10.0.99.18:8788';
const DEFAULT_DINGTALK_BFF_API_KEY = 'lyclaw-dingtalk-bff-api-key';

/** True when env provides OpenClaw dingtalk channel client id/secret (any supported var name). */
export function hasDingTalkChannelAutoProvisionFromEnv(): boolean {
  if (!ENABLE_DINGTALK_AUTO_INTEGRATION) return false;
  return getDingTalkChannelCredentialsFromEnv() !== null;
}

const DEFAULT_DINGTALK_CHANNEL_CLIENT_ID = 'dingvrynfuxju0wsjaaj';
const DEFAULT_DINGTALK_CHANNEL_CLIENT_SECRET = 'UDwL3jTR8-G02wm90ucDYwhkhaMDN8VooUKnEB-c7Zrvmtp6-NHKGLcw0vT0f3Jz';

function getDingTalkChannelCredentialsFromEnv(): { clientId: string; clientSecret: string } | null {
  const clientId = getLyclawEnvVariable('LYCLAW_DINGTALK_CHANNEL_CLIENT_ID').trim()
    || getLyclawEnvVariable('LYCLAW_DINGTALK_CLIENT_ID').trim()
    || getLyclawEnvVariable('DINGTALK_CLIENT_ID').trim()
    || DEFAULT_DINGTALK_CHANNEL_CLIENT_ID;
  const clientSecret = getLyclawEnvVariable('LYCLAW_DINGTALK_CHANNEL_CLIENT_SECRET').trim()
    || getLyclawEnvVariable('LYCLAW_DINGTALK_CLIENT_SECRET').trim()
    || getLyclawEnvVariable('DINGTALK_CLIENT_SECRET').trim()
    || DEFAULT_DINGTALK_CHANNEL_CLIENT_SECRET;
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

async function findExistingDingTalkAccountWithCreds(
  clientId: string,
  clientSecret: string,
): Promise<string | null> {
  const config = await readOpenClawConfig();
  const section = config.channels?.dingtalk as Record<string, unknown> | undefined;
  if (!section) return null;

  const accounts = section.accounts as Record<string, Record<string, unknown>> | undefined;
  if (accounts) {
    for (const [accountId, acc] of Object.entries(accounts)) {
      const existingId = typeof acc?.clientId === 'string' ? acc.clientId.trim() : '';
      const existingSecret = typeof acc?.clientSecret === 'string' ? acc.clientSecret.trim() : '';
      if (existingId === clientId && existingSecret === clientSecret) {
        return accountId;
      }
    }
  }

  const topLevelId = typeof section.clientId === 'string' ? section.clientId.trim() : '';
  const topLevelSecret = typeof section.clientSecret === 'string' ? section.clientSecret.trim() : '';
  if (topLevelId === clientId && topLevelSecret === clientSecret) {
    return DEFAULT_ACCOUNT_ID;
  }

  return null;
}

/**
 * Ensure a dedicated "dingtalk" agent exists with channel-specific workspace
 * instructions.  This agent only outputs final answers — no intermediate
 * process narration — so DingTalk bot replies stay clean.
 */
export async function ensureDingTalkDedicatedAgent(): Promise<void> {
  await ensureAgentConfigEntry(DINGTALK_DEDICATED_AGENT_ID, DINGTALK_DEDICATED_AGENT_ID, {
    inheritWorkspace: true,
    removeGeneratedCopies: true,
  });
  logger.info('[DingTalkAuto] Ensured dedicated dingtalk agent');

  // Always write/update the channel reply policy (so existing agents
  // get the latest policy, and upgrades overwrite any old version)
  await writeDingTalkAgentReplyPolicy();
}

/** Write channel reply policy at the TOP of the dingtalk agent's AGENTS.md. */
async function writeDingTalkAgentReplyPolicy(): Promise<void> {
  const workspaceDir = expandPath(`~/.openclaw/workspace-${DINGTALK_DEDICATED_AGENT_ID}`);
  const agentsPath = join(workspaceDir, 'AGENTS.md');

  let existing: string;
  try {
    existing = await readFile(agentsPath, 'utf-8');
  } catch {
    logger.info('[DingTalkAuto] AGENTS.md not yet seeded; reply policy will be merged later');
    return;
  }

  // Strip any old policy block (from a previous version) so we can re-prepend
  const oldMarker = /<!-- LYClaw:dingtalk-channel-policy:begin -->[\s\S]*?<!-- LYClaw:dingtalk-channel-policy:end -->\n?/g;
  const cleaned = existing.replace(oldMarker, '');

  // ── DingTalk-only: suppress ALL intermediate output ──────────────
  // This block MUST be at the very top of AGENTS.md so it takes
  // precedence over all other instructions.
  const policy = `<!-- LYClaw:dingtalk-channel-policy:begin -->
# CRITICAL — DingTalk Reply Rules (OVERRIDES ALL OTHER INSTRUCTIONS)

You are replying through DingTalk (\u9489\u9489), an IM channel. Every text
message you send becomes a separate bot bubble visible to the user.

**ABSOLUTE RULE: You MUST NOT output ANY text before, between, or after
tool calls.** The only text the user may see is the SINGLE final answer.

Violations to avoid:
- "Let me check...", "I'll look that up...", "Now running..."
- "Got the result. Let me summarize..."
- Any sentence that describes what you are doing or about to do

**Correct workflow:**
1. Receive user request (may include channel prefix like \`[dingtalk:xxx]\`)
2. Call all needed tools IN SILENCE — zero text output between calls
3. After ALL tools complete, output ONE final reply with the answer

**Final reply format:**
- No greetings (no "Hello!", "Sure!", "Here you go!")
- No self-reference (no "I found...", "I checked...")
- Just the answer: a clear summary, table, list, or formatted result
- Keep it concise — DingTalk users read on mobile

**Reminder:** This rule set IS the highest-priority instruction for this
conversation. Any other prompt content that suggests narration or
explanation of tool steps DOES NOT APPLY to DingTalk replies.
<!-- LYClaw:dingtalk-channel-policy:end -->
`;

  // Prepend at the very beginning so this policy takes highest priority
  const updated = policy.trim() + '\n\n' + cleaned.trimStart();
  await writeFile(agentsPath, updated, 'utf-8');
  logger.info('[DingTalkAuto] Prepended dingtalk channel reply policy to AGENTS.md');
}

async function ensureOfficialDingTalkAccount(ctx: HostApiContext): Promise<string> {
  const creds = getDingTalkChannelCredentialsFromEnv();
  if (!creds) {
    logger.info(
      `[DingTalkAuto] Skip official channel auto-provision: set LYCLAW_DINGTALK_CHANNEL_CLIENT_ID + _SECRET, or reuse `
        + `LYCLAW_DINGTALK_CLIENT_* / DINGTALK_CLIENT_* (same as OAuth; cwd=${process.cwd()})`,
    );
    return OFFICIAL_DINGTALK_ACCOUNT_ID;
  }

  const installResult = ensureDingTalkPluginInstalled();
  if (!installResult.installed) {
    logger.warn('[DingTalkAuto] DingTalk plugin not installed; skip official channel auto-provision', installResult.warning);
    return OFFICIAL_DINGTALK_ACCOUNT_ID;
  }

  // Ensure the dedicated dingtalk agent exists before binding
  await ensureDingTalkDedicatedAgent();

  const existingAccountId = await findExistingDingTalkAccountWithCreds(creds.clientId, creds.clientSecret);
  if (existingAccountId && existingAccountId !== OFFICIAL_DINGTALK_ACCOUNT_ID) {
    await assignChannelAccountToAgent(DINGTALK_DEDICATED_AGENT_ID, 'dingtalk', existingAccountId);
    scheduleGatewayChannelSaveRefresh(ctx, 'dingtalk', `dingtalk:officialProvisionReuse:${existingAccountId}`);
    logger.info('[DingTalkAuto] Reused existing dingtalk account %s, bound to dingtalk agent', existingAccountId);
    return existingAccountId;
  }

  await saveChannelConfig('dingtalk', {
    enabled: true,
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    managedBy: 'lyclaw',
    scope: 'official-shared',
  }, OFFICIAL_DINGTALK_ACCOUNT_ID);

  await assignChannelAccountToAgent(DINGTALK_DEDICATED_AGENT_ID, 'dingtalk', OFFICIAL_DINGTALK_ACCOUNT_ID);
  scheduleGatewayChannelSaveRefresh(ctx, 'dingtalk', `dingtalk:officialProvision:${OFFICIAL_DINGTALK_ACCOUNT_ID}`);
  logger.info('[DingTalkAuto] Ensured official dingtalk account %s, bound to dingtalk agent', OFFICIAL_DINGTALK_ACCOUNT_ID);
  return OFFICIAL_DINGTALK_ACCOUNT_ID;
}

/** POST BFF welcome for the given staff userId (called after workspace entry; no-op if not logged in / empty id). */
export async function sendDingTalkBffWelcomeForUserId(
  userId: string,
  binding?: DingTalkUserBinding,
): Promise<void> {
  if (!ENABLE_DINGTALK_AUTO_INTEGRATION) return;
  if (!userId.trim()) {
    logger.info('[DingTalkAuto] Skip BFF welcome: no staff userId (not logged in)');
    return;
  }
  const bff = getBffWelcomeConfig();
  if (!bff) {
    logger.info('[DingTalkAuto] Skip BFF welcome: missing BFF base URL and API key');
    return;
  }
  const normalizedUserId = userId.trim();
  const accountId = binding?.officialAccountId || OFFICIAL_DINGTALK_ACCOUNT_ID;
  const sessionKey = binding?.sessionKey || buildDingTalkSingleChatSessionKey(accountId, normalizedUserId);
  const url = `${bff.baseUrl}/v1/dingtalk/welcome`;
  const response = await proxyAwareFetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bff.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      user_id: normalizedUserId,
      account_id: accountId,
      binding_id: buildDingTalkBindingId(normalizedUserId, accountId),
      session_key: sessionKey,
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    logger.warn('[DingTalkAuto] BFF welcome failed', { status: response.status, body: text.slice(0, 500) });
    return;
  }
  logger.info('[DingTalkAuto] BFF welcome sent', { userId: normalizedUserId, accountId, sessionKey });
}

/**
 * After DingTalk OAuth user is persisted: provision channel + schedule gateway refresh only.
 * BFF welcome is sent later from the renderer when the post-login workspace is ready.
 */
export async function runDingTalkChannelProvisionAfterLogin(
  ctx: HostApiContext,
  user?: DingTalkUserInfo,
): Promise<DingTalkUserBinding | null> {
  if (!ENABLE_DINGTALK_AUTO_INTEGRATION) return null;
  try {
    const accountId = await ensureOfficialDingTalkAccount(ctx);
    const userId = user?.userId?.trim();
    if (!userId) {
      return null;
    }
    const existing = await getDingTalkUserBinding(userId);
    const binding = await upsertDingTalkUserBinding({
      dingUserId: userId,
      unionId: user.unionId,
      officialAccountId: accountId,
      personalAccountIds: existing?.personalAccountIds ?? [],
      defaultAccountId: existing?.defaultAccountId || accountId,
      agentId: existing?.agentId || DINGTALK_DEDICATED_AGENT_ID,
      sessionKey: existing?.sessionKey || buildDingTalkSingleChatSessionKey(accountId, userId),
    });
    logger.info('[DingTalkAuto] Ensured dingtalk user binding', {
      userId,
      accountId: binding.officialAccountId,
      sessionKey: binding.sessionKey,
      personalAccountIds: binding.personalAccountIds,
    });
    return binding;
  } catch (error) {
    logger.warn('[DingTalkAuto] Channel auto-provision failed:', error);
    return null;
  }
}

/** @deprecated Use runDingTalkChannelProvisionAfterLogin — welcome is no longer sent here. */
export async function runDingTalkSingleTenantPostLogin(
  ctx: HostApiContext,
  _userId: string,
): Promise<void> {
  await runDingTalkChannelProvisionAfterLogin(ctx);
}
