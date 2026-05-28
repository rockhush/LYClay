import type { ChatSession } from '@/stores/chat';

export function resolveSessionActivityMs(
  session: ChatSession,
  sessionLastActivity: Record<string, number>,
): number {
  const stored = sessionLastActivity[session.key];
  if (typeof stored === 'number' && stored > 0) return stored;
  if (typeof session.updatedAt === 'number' && session.updatedAt > 0) return session.updatedAt;
  return 0;
}

export function compareSessionsByActivity(
  left: ChatSession,
  right: ChatSession,
  sessionLastActivity: Record<string, number>,
): number {
  return resolveSessionActivityMs(right, sessionLastActivity) - resolveSessionActivityMs(left, sessionLastActivity);
}

/** Fill missing activity timestamps without overwriting values already in memory. */
export function mergeDiscoveredSessionActivity(
  existing: Record<string, number>,
  discovered: Record<string, number>,
): Record<string, number> {
  const next = { ...existing };
  for (const [key, activity] of Object.entries(discovered)) {
    if (!(key in next) || next[key] <= 0) {
      next[key] = activity;
    }
  }
  return next;
}

/**
 * Keep sidebar session order stable while browsing. Existing keys retain their
 * relative positions; newly discovered sessions are prepended (most recent first).
 */
export function buildStableSessionOrder(
  sessions: ChatSession[],
  sessionLastActivity: Record<string, number>,
  previousOrder: readonly string[],
): string[] {
  const knownKeys = new Set(sessions.map((session) => session.key));
  const orderedKeys = previousOrder.filter((key) => knownKeys.has(key));
  const orderedSet = new Set(orderedKeys);

  const newcomers = sessions
    .filter((session) => !orderedSet.has(session.key))
    .sort((left, right) => compareSessionsByActivity(left, right, sessionLastActivity));

  if (orderedKeys.length === 0) {
    return newcomers.map((session) => session.key);
  }

  return [...newcomers.map((session) => session.key), ...orderedKeys];
}
