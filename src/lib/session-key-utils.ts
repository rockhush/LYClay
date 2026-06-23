import type { ChatSession } from '@/stores/chat';

/** OpenClaw child runs use keys like agent:main:subagent:<uuid>. */
export function isSubagentSessionKey(sessionKey: string | undefined | null): boolean {
  const normalized = sessionKey?.trim();
  if (!normalized) return false;
  return /:subagent:/i.test(normalized);
}

const KNOWN_CHANNEL_SESSION_IDS = new Set([
  'dingtalk',
  'feishu',
  'wecom',
  'qqbot',
  'telegram',
  'discord',
  'whatsapp',
  'wechat',
  'signal',
  'imessage',
  'matrix',
  'line',
  'msteams',
  'googlechat',
  'mattermost',
]);

function isKnownChannel(value: string | undefined): boolean {
  return Boolean(value && KNOWN_CHANNEL_SESSION_IDS.has(value.toLowerCase()));
}

/**
 * OpenClaw channel group mirror sessions look like:
 * agent:<agentId>:<channel>:group:<groupId>
 *
 * They are external channel target mirrors, not the user's active DingTalk entry session.
 * Direct sessions are intentionally kept visible because they hold the real bot chat history.
 */
export function isChannelMirrorSessionKey(sessionKey: string | undefined | null): boolean {
  const normalized = sessionKey?.trim();
  if (!normalized) return false;

  const parts = normalized.split(':');
  const lowerParts = parts.map((part) => part.toLowerCase());

  return lowerParts.length >= 5
    && lowerParts[0] === 'agent'
    && isKnownChannel(lowerParts[2])
    && lowerParts[3] === 'group';
}
export function isUserFacingSessionKey(sessionKey: string | undefined | null): boolean {
  return !isSubagentSessionKey(sessionKey) && !isChannelMirrorSessionKey(sessionKey);
}

export function pickUserFacingSession(
  sessions: ChatSession[],
  preferredKey?: string,
): ChatSession | undefined {
  if (preferredKey && isUserFacingSessionKey(preferredKey)) {
    const preferred = sessions.find((session) => session.key === preferredKey);
    if (preferred) return preferred;
  }
  return sessions.find((session) => isUserFacingSessionKey(session.key));
}
