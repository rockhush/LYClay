import { describe, expect, it } from 'vitest';
import type { ChatSession } from '@/stores/chat';
import { buildBatchDeleteSessionGroups } from '@/lib/session-batch-delete-groups';

const NOW_MS = new Date('2026-06-15T12:00:00').getTime();

function session(
  key: string,
  overrides: Partial<ChatSession> = {},
): ChatSession {
  return {
    key,
    displayName: key,
    ...overrides,
  } as ChatSession;
}

const bucketLabels = {
  pinned: 'Pinned',
  today: 'Today',
  yesterday: 'Yesterday',
  withinWeek: 'Within week',
  withinTwoWeeks: 'Within two weeks',
  withinMonth: 'Within month',
  older: 'Older',
};

describe('buildBatchDeleteSessionGroups', () => {
  it('groups workspace sessions separately from time buckets', () => {
    const groups = buildBatchDeleteSessionGroups({
      sessions: [
        session('ws-session', { label: 'Workspace chat', lastMessageAt: NOW_MS - 2 * 24 * 60 * 60 * 1000 }),
        session('today-session', { label: 'Today chat', lastMessageAt: NOW_MS - 60 * 60 * 1000 }),
      ],
      sessionLastActivity: {},
      sessionWorkspaceIds: { 'ws-session': 'ws-1' },
      sessionPinnedAt: {},
      workspaces: [{ id: 'ws-1', name: 'test2', createdAt: 1 }],
      nowMs: NOW_MS,
      resolveTitle: (item) => item.label ?? item.key,
      workspaceGroupLabel: (name) => `Workspace · ${name}`,
      bucketLabels,
    });

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      id: 'workspace:ws-1',
      label: 'Workspace · test2',
      sessions: [{ key: 'ws-session', title: 'Workspace chat' }],
    });
    expect(groups[1]).toMatchObject({
      id: 'bucket:today',
      label: 'Today',
      sessions: [{ key: 'today-session', title: 'Today chat' }],
    });
  });

  it('places pinned non-workspace sessions in the pinned group', () => {
    const groups = buildBatchDeleteSessionGroups({
      sessions: [
        session('pinned-session', { label: 'Pinned chat', lastMessageAt: NOW_MS - 10 * 24 * 60 * 60 * 1000 }),
      ],
      sessionLastActivity: {},
      sessionWorkspaceIds: {},
      sessionPinnedAt: { 'pinned-session': NOW_MS },
      workspaces: [],
      nowMs: NOW_MS,
      resolveTitle: (item) => item.label ?? item.key,
      workspaceGroupLabel: (name) => `Workspace · ${name}`,
      bucketLabels,
    });

    expect(groups).toEqual([
      {
        id: 'pinned',
        label: 'Pinned',
        sessions: [{ key: 'pinned-session', title: 'Pinned chat' }],
      },
    ]);
  });
});
