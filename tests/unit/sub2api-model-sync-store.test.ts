import { beforeEach, describe, expect, it, vi } from 'vitest';

const memory = new Map<string, unknown>();

vi.mock('@electron/services/providers/store-instance', () => ({
  getClawXProviderStore: vi.fn(async () => ({
    get: (key: string) => memory.get(key),
    set: (key: string, value: unknown) => memory.set(key, value),
  })),
}));

import {
  listSub2ApiSyncStatus,
  recordSub2ApiSyncFailure,
  recordSub2ApiSyncStarted,
  recordSub2ApiSyncSuccess,
} from '../../electron/services/sub2api/model-sync-store';

describe('Sub2API model sync status store', () => {
  beforeEach(() => {
    memory.clear();
  });

  it('records success status without raw identity', async () => {
    const started = await recordSub2ApiSyncStarted({
      scope: 'global',
      subjectHash: 'abc12345',
      source: 'dingtalk.jobNumber',
      now: '2026-07-06T10:00:00.000Z',
    });

    await recordSub2ApiSyncSuccess({
      scope: 'global',
      subjectHash: 'abc12345',
      source: 'dingtalk.jobNumber',
      modelCount: 2,
      startedAt: started.lastStartedAt,
      now: '2026-07-06T10:00:01.250Z',
    });

    const statuses = await listSub2ApiSyncStatus();
    expect(statuses).toEqual([expect.objectContaining({
      scope: 'global',
      subjectHash: 'abc12345',
      source: 'dingtalk.jobNumber',
      status: 'success',
      modelCount: 2,
      lastStartedAt: '2026-07-06T10:00:00.000Z',
      lastSuccessAt: '2026-07-06T10:00:01.250Z',
      durationMs: 1250,
      errorCode: null,
    })]);
    expect(JSON.stringify(memory.get('sub2apiSyncStatus'))).not.toContain('EMP001');
  });

  it('records failure status with error code only', async () => {
    await recordSub2ApiSyncFailure({
      scope: 'digitalEmployee',
      subjectHash: 'def67890',
      source: 'manifest.package.id.lastSegment',
      modelCount: 0,
      errorCode: 'timeout',
      startedAt: '2026-07-06T10:00:00.000Z',
      now: '2026-07-06T10:00:05.000Z',
    });

    await expect(listSub2ApiSyncStatus()).resolves.toEqual([expect.objectContaining({
      scope: 'digitalEmployee',
      subjectHash: 'def67890',
      status: 'failed',
      modelCount: 0,
      durationMs: 5000,
      errorCode: 'timeout',
    })]);
  });

  it('lists latest records sorted by update time descending', async () => {
    await recordSub2ApiSyncStarted({ scope: 'global', subjectHash: 'old', source: 'dingtalk.userId', now: '2026-07-06T09:00:00.000Z' });
    await recordSub2ApiSyncStarted({ scope: 'global', subjectHash: 'new', source: 'dingtalk.userId', now: '2026-07-06T10:00:00.000Z' });

    const statuses = await listSub2ApiSyncStatus();

    expect(statuses.map((status) => status.subjectHash)).toEqual(['new', 'old']);
  });

  it('does not persist raw api keys or user numbers passed accidentally', async () => {
    await recordSub2ApiSyncFailure({
      scope: 'global',
      subjectHash: 'safehash',
      source: 'dingtalk.jobNumber',
      modelCount: 0,
      errorCode: '40101',
      startedAt: '2026-07-06T10:00:00.000Z',
      now: '2026-07-06T10:00:01.000Z',
      userNo: 'EMP001',
      apiKey: 'sk-secret',
    } as never);

    const persisted = JSON.stringify(memory.get('sub2apiSyncStatus'));
    expect(persisted).not.toContain('EMP001');
    expect(persisted).not.toContain('sk-secret');
  });
});

