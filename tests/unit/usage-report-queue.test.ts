import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const settingsStub: Record<string, unknown> = {};

vi.mock('@electron/utils/store', () => ({
  getSetting: vi.fn(async (key: string) => settingsStub[key]),
  setSetting: vi.fn(async (key: string, value: unknown) => {
    settingsStub[key] = value;
  }),
}));

import {
  appendSkillDownloadRecord,
  appendSkillInvokeRecord,
  appendTokenConsumeRecord,
  detachAllRecords,
  getUsageReportQueueSnapshot,
  recordSuccessfulUpload,
  restoreFailedRecords,
} from '@electron/utils/reporting/queue';

beforeEach(() => {
  for (const key of Object.keys(settingsStub)) delete settingsStub[key];
  settingsStub.usageReportQueue = {
    tokenConsume: [],
    skillDownload: [],
    skillInvoke: [],
  };
  settingsStub.usageReportLastUploadAt = {
    tokenConsume: null,
    skillDownload: null,
    skillInvoke: null,
  };
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('appendTokenConsumeRecord', () => {
  it('appends a record with consumeTime (seconds) when input is a Date', async () => {
    await appendTokenConsumeRecord({
      workNo: 'EMP00123',
      model: 'gpt-4o-mini',
      consume: 1500,
      consumeTime: new Date(2026, 4, 20, 23, 20, 45),
    });
    const snap = await getUsageReportQueueSnapshot();
    expect(snap.tokenConsume).toEqual([
      {
        workNo: 'EMP00123',
        model: 'gpt-4o-mini',
        consume: 1500,
        consumeTime: '2026-05-20 23:20:45',
      },
    ]);
  });

  it('falls back to legacy `date` alias and pads seconds to :00', async () => {
    await appendTokenConsumeRecord({
      workNo: 'EMP00123',
      model: 'gpt-4o-mini',
      consume: 800,
      date: '2026-05-20 14:29',
    });
    const snap = await getUsageReportQueueSnapshot();
    expect(snap.tokenConsume).toEqual([
      {
        workNo: 'EMP00123',
        model: 'gpt-4o-mini',
        consume: 800,
        consumeTime: '2026-05-20 14:29:00',
      },
    ]);
  });

  it('skips records with non-positive consume or empty model', async () => {
    await appendTokenConsumeRecord({ workNo: 'X', model: '', consume: 100 });
    await appendTokenConsumeRecord({ workNo: 'X', model: 'gpt', consume: 0 });
    await appendTokenConsumeRecord({ workNo: 'X', model: 'gpt', consume: -5 });
    const snap = await getUsageReportQueueSnapshot();
    expect(snap.tokenConsume).toEqual([]);
  });
});

describe('appendSkill*Record', () => {
  it('download uses downloadTime+seconds, invoke uses invokeTime+seconds', async () => {
    await appendSkillDownloadRecord({
      workNo: 'EMP00123',
      skillId: '  SKILL_007  ',
      downloadTime: new Date(2026, 4, 20, 23, 20, 45),
    });
    await appendSkillInvokeRecord({
      workNo: 'EMP00123',
      skillId: 'SKILL_008',
      count: 5,
      invokeTime: new Date(2026, 4, 20, 12, 30, 9),
    });
    const snap = await getUsageReportQueueSnapshot();
    expect(snap.skillDownload).toEqual([
      {
        workNo: 'EMP00123',
        skillId: 'SKILL_007',
        count: 1,
        downloadTime: '2026-05-20 23:20:45',
      },
    ]);
    expect(snap.skillInvoke).toEqual([
      {
        workNo: 'EMP00123',
        skillId: 'SKILL_008',
        count: 5,
        invokeTime: '2026-05-20 12:30:09',
      },
    ]);
  });

  it('skill-download/invoke fall back to legacy `date` alias and pad :00', async () => {
    await appendSkillDownloadRecord({
      workNo: 'EMP00123',
      skillId: 'SKILL_007',
      count: 3,
      date: '2026-05-20 14:30',
    });
    await appendSkillInvokeRecord({
      workNo: 'EMP00123',
      skillId: 'SKILL_007',
      count: 5,
      date: '2026-05-20 14:30',
    });
    const snap = await getUsageReportQueueSnapshot();
    expect(snap.skillDownload[0].downloadTime).toBe('2026-05-20 14:30:00');
    expect(snap.skillInvoke[0].invokeTime).toBe('2026-05-20 14:30:00');
  });

  it('coerces non-positive count to 1', async () => {
    await appendSkillInvokeRecord({
      workNo: '', skillId: 'X', count: 0, invokeTime: new Date(2026, 4, 20, 12, 0, 0),
    });
    const snap = await getUsageReportQueueSnapshot();
    expect(snap.skillInvoke[0].count).toBe(1);
  });
});

describe('detachAllRecords + restoreFailedRecords', () => {
  it('detaches the entire queue and restores prepended on failure', async () => {
    await appendTokenConsumeRecord({
      workNo: 'A', model: 'gpt-4', consume: 100,
      consumeTime: new Date(2026, 4, 20, 1, 0, 0),
    });
    await appendSkillDownloadRecord({
      workNo: 'A', skillId: 'SKILL_007',
      date: new Date(2026, 4, 20, 2, 0),
    });

    const detached = await detachAllRecords();
    expect(detached.tokenConsume.length).toBe(1);
    expect(detached.skillDownload.length).toBe(1);

    // Queue is empty after detach.
    const afterDetach = await getUsageReportQueueSnapshot();
    expect(afterDetach.tokenConsume).toEqual([]);
    expect(afterDetach.skillDownload).toEqual([]);

    // A new record arrives between detach and restore.
    await appendTokenConsumeRecord({
      workNo: 'A', model: 'gpt-4', consume: 200,
      date: new Date(2026, 4, 20, 3, 0),
    });

    // Failed records get prepended (oldest first).
    await restoreFailedRecords({
      tokenConsume: detached.tokenConsume,
      skillDownload: detached.skillDownload,
    });
    const restored = await getUsageReportQueueSnapshot();
    expect(restored.tokenConsume.map((r) => r.consume)).toEqual([100, 200]);
    expect(restored.skillDownload).toHaveLength(1);
  });
});

describe('recordSuccessfulUpload', () => {
  it('updates only the targeted channel timestamp', async () => {
    await recordSuccessfulUpload('tokenConsume', '2026-05-20T03:20:00.000Z');
    const last = settingsStub.usageReportLastUploadAt as Record<string, string | null>;
    expect(last.tokenConsume).toBe('2026-05-20T03:20:00.000Z');
    expect(last.skillDownload).toBeNull();
    expect(last.skillInvoke).toBeNull();
  });
});
