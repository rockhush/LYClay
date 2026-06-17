import type { ChatSession } from '@/stores/chat';
import { getSessionBucket, resolveSessionActivityMs, type SessionBucketKey } from '@/lib/session-sidebar-order';

export type BatchDeleteSessionItem = {
  key: string;
  title: string;
};

export type BatchDeleteSessionGroup = {
  id: string;
  label: string;
  sessions: BatchDeleteSessionItem[];
};

export type BatchDeleteBucketLabels = Record<SessionBucketKey, string> & {
  pinned: string;
};

const BUCKET_ORDER: SessionBucketKey[] = [
  'today',
  'yesterday',
  'withinWeek',
  'withinTwoWeeks',
  'withinMonth',
  'older',
];

export function buildBatchDeleteSessionGroups(params: {
  sessions: ChatSession[];
  sessionLastActivity: Record<string, number>;
  sessionWorkspaceIds: Record<string, string>;
  sessionPinnedAt: Record<string, number>;
  workspaces: Array<{ id: string; name: string; createdAt: number }>;
  nowMs: number;
  resolveTitle: (session: ChatSession) => string;
  workspaceGroupLabel: (name: string) => string;
  bucketLabels: BatchDeleteBucketLabels;
}): BatchDeleteSessionGroup[] {
  const {
    sessions,
    sessionLastActivity,
    sessionWorkspaceIds,
    sessionPinnedAt,
    workspaces,
    nowMs,
    resolveTitle,
    workspaceGroupLabel,
    bucketLabels,
  } = params;

  const workspaceIdsKnown = new Set(workspaces.map((workspace) => workspace.id));
  const assignedKeys = new Set<string>();
  const groups: BatchDeleteSessionGroup[] = [];

  const isUnderWorkspace = (sessionKey: string) => {
    const workspaceId = sessionWorkspaceIds[sessionKey];
    return Boolean(workspaceId && workspaceIdsKnown.has(workspaceId));
  };

  const isPinned = (sessionKey: string) =>
    Number.isFinite(sessionPinnedAt[sessionKey]) && sessionPinnedAt[sessionKey] > 0;

  const toItem = (session: ChatSession): BatchDeleteSessionItem => ({
    key: session.key,
    title: resolveTitle(session),
  });

  for (const workspace of [...workspaces].sort((left, right) => right.createdAt - left.createdAt)) {
    const workspaceSessions = sessions.filter((session) => sessionWorkspaceIds[session.key] === workspace.id);
    if (workspaceSessions.length === 0) continue;
    for (const session of workspaceSessions) {
      assignedKeys.add(session.key);
    }
    groups.push({
      id: `workspace:${workspace.id}`,
      label: workspaceGroupLabel(workspace.name),
      sessions: workspaceSessions.map(toItem),
    });
  }

  const pinnedSessions = sessions.filter(
    (session) => !assignedKeys.has(session.key) && isPinned(session.key) && !isUnderWorkspace(session.key),
  );
  if (pinnedSessions.length > 0) {
    for (const session of pinnedSessions) {
      assignedKeys.add(session.key);
    }
    groups.push({
      id: 'pinned',
      label: bucketLabels.pinned,
      sessions: pinnedSessions.map(toItem),
    });
  }

  for (const bucketKey of BUCKET_ORDER) {
    const bucketSessions = sessions.filter((session) => {
      if (assignedKeys.has(session.key)) return false;
      if (isPinned(session.key)) return false;
      if (isUnderWorkspace(session.key)) return false;
      return getSessionBucket(
        resolveSessionActivityMs(session, sessionLastActivity),
        nowMs,
      ) === bucketKey;
    });
    if (bucketSessions.length === 0) continue;
    for (const session of bucketSessions) {
      assignedKeys.add(session.key);
    }
    groups.push({
      id: `bucket:${bucketKey}`,
      label: bucketLabels[bucketKey],
      sessions: bucketSessions.map(toItem),
    });
  }

  return groups;
}

export function flattenBatchDeleteSessionGroups(
  groups: BatchDeleteSessionGroup[],
): BatchDeleteSessionItem[] {
  return groups.flatMap((group) => group.sessions);
}
