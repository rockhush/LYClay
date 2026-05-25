import { beforeEach, describe, expect, it, vi } from 'vitest';

const settingsStub: Record<string, unknown> = {};

vi.mock('@electron/utils/store', () => ({
  getSetting: vi.fn(async (key: string) => settingsStub[key]),
  setSetting: vi.fn(async (key: string, value: unknown) => {
    settingsStub[key] = value;
  }),
}));

vi.mock('@electron/utils/dingtalk-oauth', () => ({
  enrichDingTalkUserProfile: vi.fn(async (user: { jobNumber?: string; userId?: string }) => user),
}));

import {
  applyWorkNoToQueueSnapshot,
  cacheWorkNo,
  clearCachedWorkNo,
  ensureWorkNoReady,
  hydrateWorkNoCacheFromStore,
  resolveWorkNo,
} from '@electron/utils/reporting/work-no';

beforeEach(() => {
  for (const key of Object.keys(settingsStub)) delete settingsStub[key];
});

describe('usage-report workNo', () => {
  it('caches jobNumber on resolve and reuses cached value when live session is empty', async () => {
    settingsStub.dingtalkUser = { jobNumber: 'EMP00123' };
    await expect(resolveWorkNo()).resolves.toBe('EMP00123');
    settingsStub.dingtalkUser = { jobNumber: '' };
    await expect(resolveWorkNo()).resolves.toBe('EMP00123');
  });

  it('falls back to DingTalk userId when jobNumber is missing', async () => {
    settingsStub.dingtalkUser = { jobNumber: '', userId: '11427192' };
    await expect(resolveWorkNo()).resolves.toBe('11427192');
    expect(settingsStub.usageReportCachedWorkNo).toBe('11427192');
  });

  it('hydrates cache from dingtalk user on startup', async () => {
    settingsStub.dingtalkUser = { jobNumber: 'A10086', userId: '11427192' };
    await expect(hydrateWorkNoCacheFromStore()).resolves.toBe('A10086');
    expect(settingsStub.usageReportCachedWorkNo).toBe('A10086');
  });

  it('backfills empty queue records before upload', () => {
    const next = applyWorkNoToQueueSnapshot({
      tokenConsume: [{
        workNo: '',
        model: 'deepseek-v4-pro',
        consume: 100,
        consumeTime: '2026-05-25 16:11:15',
      }],
      skillDownload: [],
      skillInvoke: [],
    }, 'EMP00123');

    expect(next.tokenConsume[0]?.workNo).toBe('EMP00123');
  });

  it('ensureWorkNoReady uses cached workNo when profile enrichment is unavailable', async () => {
    settingsStub.dingtalkUser = { jobNumber: '', userId: '11427192' };
    await expect(ensureWorkNoReady()).resolves.toBe('11427192');
  });

  it('clears cached workNo on logout helper', async () => {
    await cacheWorkNo('EMP00123');
    await clearCachedWorkNo();
    expect(settingsStub.usageReportCachedWorkNo).toBeNull();
  });
});
