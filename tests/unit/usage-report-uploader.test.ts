import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const settingsStub: Record<string, unknown> = {};
const fetchMock = vi.fn();

vi.mock('@electron/utils/store', () => ({
  getSetting: vi.fn(async (key: string) => settingsStub[key]),
  setSetting: vi.fn(async (key: string, value: unknown) => {
    settingsStub[key] = value;
  }),
}));

vi.mock('@electron/utils/proxy-fetch', () => ({
  proxyAwareFetch: (...args: unknown[]) => fetchMock(...args),
}));

vi.mock('@electron/utils/dingtalk-oauth', () => ({
  getLyclawEnvVariable: () => '',
}));

// Stub the transcript scanner used by flushUsageReports — it would otherwise
// hit the real OpenClaw config dir on disk during unit tests. Tests that care
// about the scan path can override this via `vi.mocked(...).mockImplementation`.
vi.mock('@electron/utils/reporting/transcript-scan', () => ({
  scanTranscriptsForTokenConsume: vi.fn(async () => ({
    scanned: 0,
    queued: 0,
    newCursor: null,
    skippedReasons: {},
  })),
}));

import {
  appendSkillDownloadRecord,
  appendSkillInvokeRecord,
  appendTokenConsumeRecord,
  getUsageReportQueueSnapshot,
} from '@electron/utils/reporting/queue';
import { flushUsageReports } from '@electron/utils/reporting/uploader';

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
  fetchMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

function jsonResponse(payload: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: async () => payload,
  } as unknown as Response;
}

describe('flushUsageReports', () => {
  it('skips all network calls when every channel queue is empty', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ code: 200, msg: 'ok', data: true }));
    const result = await flushUsageReports('test');
    // Empty queues must NOT generate any HTTP traffic — ops asked us to drop
    // the heartbeat-style "[] every launch" behavior because it polluted
    // backend access logs.
    expect(fetchMock).toHaveBeenCalledTimes(0);
    expect(result.uploaded.tokenConsume).toBe(0);
    expect(result.uploaded.skillDownload).toBe(0);
    expect(result.uploaded.skillInvoke).toBe(0);
    expect(result.diagnostics).toEqual([]);
  });

  it('only posts the channels that have records', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ code: 200, msg: 'ok', data: true }));
    await appendSkillInvokeRecord({
      workNo: 'A', skillId: 'SKILL_007', count: 1,
      invokeTime: new Date(2026, 4, 20, 12, 0, 0),
    });
    const result = await flushUsageReports('test');
    // Only skill-invoke had data → exactly one POST to that endpoint.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://100.0.4.203/management/claw/report/skill-invoke');
    expect(result.uploaded.tokenConsume).toBe(0);
    expect(result.uploaded.skillDownload).toBe(0);
    expect(result.uploaded.skillInvoke).toBe(1);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].channel).toBe('skillInvoke');
  });

  it('posts each non-empty channel and clears the queue on success', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ code: 200, msg: 'ok', data: true }));
    await appendTokenConsumeRecord({
      workNo: 'A', model: 'gpt-4', consume: 1500,
      consumeTime: new Date(2026, 4, 20, 23, 20, 45),
    });
    await appendSkillDownloadRecord({
      workNo: 'A', skillId: 'SKILL_007',
      date: new Date(2026, 4, 20, 23, 20),
    });
    await appendSkillInvokeRecord({
      workNo: 'A', skillId: 'SKILL_007', count: 5,
      date: new Date(2026, 4, 20, 12, 30),
    });

    const result = await flushUsageReports('test');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const calledUrls = fetchMock.mock.calls.map((c) => c[0] as string).sort();
    expect(calledUrls).toEqual([
      'http://portal.srv.lstech.com/management/claw/report/skill-download',
      'http://portal.srv.lstech.com/management/claw/report/skill-invoke',
      'http://portal.srv.lstech.com/management/claw/report/token-consume',
    ]);

    // Bodies are exact arrays of records.
    const tokenCall = fetchMock.mock.calls.find(
      (c) => (c[0] as string).endsWith('token-consume'),
    );
    expect(tokenCall).toBeTruthy();
    const tokenBody = JSON.parse((tokenCall![1] as RequestInit).body as string);
    expect(tokenBody).toEqual([
      {
        workNo: 'A',
        model: 'gpt-4',
        consume: 1500,
        consumeTime: '2026-05-20 23:20:45',
      },
    ]);

    expect(result.uploaded).toEqual({
      tokenConsume: 1, skillDownload: 1, skillInvoke: 1,
    });
    expect(result.errors).toEqual({
      tokenConsume: null, skillDownload: null, skillInvoke: null,
    });

    const after = await getUsageReportQueueSnapshot();
    expect(after.tokenConsume).toEqual([]);
    expect(after.skillDownload).toEqual([]);
    expect(after.skillInvoke).toEqual([]);
  });

  it('restores records back into the queue when upload fails', async () => {
    // Token-consume succeeds, skill-download backend rejects with code 400.
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('skill-download')) {
        return jsonResponse({ code: 400, msg: 'count must be positive', data: null });
      }
      return jsonResponse({ code: 200, msg: 'ok', data: true });
    });

    await appendTokenConsumeRecord({
      workNo: 'A', model: 'gpt-4', consume: 100,
      consumeTime: new Date(2026, 4, 20, 1, 0, 0),
    });
    await appendSkillDownloadRecord({
      workNo: 'A', skillId: 'SKILL_007',
      date: new Date(2026, 4, 20, 2, 0),
    });

    const result = await flushUsageReports('test');

    expect(result.uploaded.tokenConsume).toBe(1);
    expect(result.uploaded.skillDownload).toBe(0);
    expect(result.errors.skillDownload).toMatch(/400/);

    // Token queue cleared, skill-download restored for next retry.
    const after = await getUsageReportQueueSnapshot();
    expect(after.tokenConsume).toEqual([]);
    expect(after.skillDownload).toHaveLength(1);
    expect(after.skillDownload[0].skillId).toBe('SKILL_007');
  });

  it('retains records when the network throws', async () => {
    fetchMock.mockRejectedValue(new Error('ENETUNREACH'));
    await appendTokenConsumeRecord({
      workNo: 'A', model: 'gpt-4', consume: 100,
      consumeTime: new Date(2026, 4, 20, 1, 0, 0),
    });

    const result = await flushUsageReports('test');
    expect(result.uploaded.tokenConsume).toBe(0);
    expect(result.errors.tokenConsume).toMatch(/ENETUNREACH/);
    const after = await getUsageReportQueueSnapshot();
    expect(after.tokenConsume).toHaveLength(1);
  });
});
