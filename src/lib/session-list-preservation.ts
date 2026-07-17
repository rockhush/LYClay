import { isUserFacingSessionKey } from '@/lib/session-key-utils';
import type { ChatSession } from '@/stores/chat/types';

export type SessionPreservationSnapshot = {
  sessions: ChatSession[];
  sessionLabels: Record<string, string>;
  customSessionLabels: Record<string, string>;
  sessionLastActivity: Record<string, number>;
  sessionWorkspaceIds: Record<string, string>;
};

export type MergePreservedSessionsOptions = {
  currentSessionKey?: string;
  interruptedSendSessionKey?: string | null;
};

/**
 * Gateway `sessions.list` can lag behind a session the user just messaged in,
 * and omits uninstalled digital-employee agents entirely. Keep sidebar rows for
 * in-flight sessions and any session we already labeled or stamped locally.
 */
export function mergePreservedSessionsIntoGatewayList(
  dedupedSessions: ChatSession[],
  snapshot: SessionPreservationSnapshot,
  options: MergePreservedSessionsOptions = {},
): ChatSession[] {
  const {
    sessions: prevSessions,
    sessionLabels,
    customSessionLabels,
    sessionLastActivity,
    sessionWorkspaceIds,
  } = snapshot;
  const { currentSessionKey, interruptedSendSessionKey } = options;
  const keys = new Set(dedupedSessions.map((s) => s.key));
  const out: ChatSession[] = [...dedupedSessions];

  const resolveDisplayName = (key: string, displayName?: string): string => {
    return displayName ?? customSessionLabels[key] ?? sessionLabels[key] ?? key;
  };

  const addIfMissing = (key: string, displayName?: string) => {
    if (!key || keys.has(key) || !isUserFacingSessionKey(key)) return;
    keys.add(key);
    out.push({
      key,
      displayName: resolveDisplayName(key, displayName),
    });
  };

  if (interruptedSendSessionKey) {
    addIfMissing(interruptedSendSessionKey);
  }

  for (const s of prevSessions) {
    if (keys.has(s.key)) continue;
    if (
      sessionLabels[s.key]
      || customSessionLabels[s.key]
      || sessionLastActivity[s.key]
      || sessionWorkspaceIds[s.key]
    ) {
      addIfMissing(s.key, s.displayName);
    }
  }

  const persistedKeys = new Set<string>([
    ...Object.keys(sessionLastActivity),
    ...Object.keys(sessionLabels),
    ...Object.keys(customSessionLabels),
    ...Object.keys(sessionWorkspaceIds),
  ]);
  for (const key of persistedKeys) {
    if (
      sessionLabels[key]
      || customSessionLabels[key]
      || sessionLastActivity[key]
      || sessionWorkspaceIds[key]
    ) {
      addIfMissing(key);
    }
  }

  // Always preserve the session the user is currently viewing, even if it
  // has no label, activity timestamp, or workspace binding.
  if (currentSessionKey && !keys.has(currentSessionKey)) {
    const currentEntry = prevSessions.find((s) => s.key === currentSessionKey);
    addIfMissing(currentSessionKey, currentEntry?.displayName);
  }

  return out;
}

/** Attach local-only summaries (e.g. retired agent archives) missing from Gateway list. */
export function appendLocalOnlySessionSummaries(
  gatewaySessions: ChatSession[],
  localSessions: ChatSession[],
): ChatSession[] {
  if (localSessions.length === 0) return gatewaySessions;
  const keys = new Set(gatewaySessions.map((session) => session.key));
  const out = [...gatewaySessions];
  for (const local of localSessions) {
    if (keys.has(local.key)) continue;
    keys.add(local.key);
    out.push(local);
  }
  return out;
}
