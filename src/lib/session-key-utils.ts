import type { ChatSession } from '@/stores/chat';

/** OpenClaw child runs use keys like agent:main:subagent:<uuid>. */
export function isSubagentSessionKey(sessionKey: string | undefined | null): boolean {
  const normalized = sessionKey?.trim();
  if (!normalized) return false;
  return /:subagent:/i.test(normalized);
}

export function isUserFacingSessionKey(sessionKey: string | undefined | null): boolean {
  return !isSubagentSessionKey(sessionKey);
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
