import type { ChatSession } from '@/stores/chat';

export type SessionBucketKey =
  | 'today'
  | 'yesterday'
  | 'withinWeek'
  | 'withinTwoWeeks'
  | 'withinMonth'
  | 'older';

export function resolveSessionListActivityMs(session: ChatSession): number | undefined {
  if (typeof session.lastMessageAt === 'number' && session.lastMessageAt > 0) {
    return session.lastMessageAt;
  }
  if (typeof session.updatedAt === 'number' && session.updatedAt > 0) {
    return session.updatedAt;
  }
  return undefined;
}

export function resolveSessionActivityMs(
  session: ChatSession,
  sessionLastActivity: Record<string, number>,
): number {
  if (typeof session.lastMessageAt === 'number' && session.lastMessageAt > 0) {
    return session.lastMessageAt;
  }

  const stored = sessionLastActivity[session.key];
  if (typeof stored === 'number' && stored > 0) return stored;

  if (typeof session.updatedAt === 'number' && session.updatedAt > 0) return session.updatedAt;
  return 0;
}

export function getSessionBucket(activityMs: number, nowMs: number): SessionBucketKey {
  if (!activityMs || activityMs <= 0) return 'older';

  const now = new Date(nowMs);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;

  if (activityMs >= startOfToday) return 'today';
  if (activityMs >= startOfYesterday) return 'yesterday';

  const daysAgo = (startOfToday - activityMs) / (24 * 60 * 60 * 1000);
  if (daysAgo <= 7) return 'withinWeek';
  if (daysAgo <= 14) return 'withinTwoWeeks';
  if (daysAgo <= 30) return 'withinMonth';
  return 'older';
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
