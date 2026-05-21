import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TokenUsageHistoryEntry } from '@electron/utils/token-usage-core';

const settingsStub: Record<string, unknown> = {};
const historyMock = vi.fn<() => Promise<TokenUsageHistoryEntry[]>>();

vi.mock('@electron/utils/store', () => ({
  getSetting: vi.fn(async (key: string) => settingsStub[key]),
  setSetting: vi.fn(async (key: string, value: unknown) => {
    settingsStub[key] = value;
  }),
}));

vi.mock('@electron/utils/token-usage', () => ({
  getRecentTokenUsageHistory: (...args: unknown[]) => historyMock(...args as []),
}));

import { scanTranscriptsForTokenConsume } from '@electron/utils/reporting/transcript-scan';
import { getUsageReportQueueSnapshot } from '@electron/utils/reporting/queue';

function makeEntry(overrides: Partial<TokenUsageHistoryEntry> = {}): TokenUsageHistoryEntry {
  return {
    timestamp: '2026-05-20T06:30:00.000Z',
    sessionId: 'session-A',
    agentId: 'agent-A',
    model: 'gpt-4o-mini',
    usageStatus: 'available',
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 150,
    ...overrides,
  };
}

beforeEach(() => {
  for (const key of Object.keys(settingsStub)) delete settingsStub[key];
  settingsStub.usageReportQueue = {
    tokenConsume: [],
    skillDownload: [],
    skillInvoke: [],
  };
  settingsStub.dingtalkUser = { jobNumber: 'EMP00124' };
  historyMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('scanTranscriptsForTokenConsume', () => {
  it('queues every available entry and advances cursor on first run', async () => {
    historyMock.mockResolvedValue([
      makeEntry({ timestamp: '2026-05-20T06:30:00.000Z', totalTokens: 150 }),
      makeEntry({ timestamp: '2026-05-20T06:31:00.000Z', totalTokens: 200, model: 'claude-sonnet-4' }),
    ]);
    const result = await scanTranscriptsForTokenConsume();
    expect(result.queued).toBe(2);
    expect(result.newCursor).toBe('2026-05-20T06:31:00.000Z');
    const snap = await getUsageReportQueueSnapshot();
    expect(snap.tokenConsume).toHaveLength(2);
    expect(snap.tokenConsume[0]).toMatchObject({
      workNo: 'EMP00124',
      model: 'gpt-4o-mini',
      consume: 150,
    });
    // Local-time format depends on TZ, just check shape "YYYY-MM-DD HH:MM:SS".
    expect(snap.tokenConsume[0].consumeTime).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(settingsStub.usageReportTokenScanCursor).toBe('2026-05-20T06:31:00.000Z');
  });

  it('skips entries older or equal to cursor', async () => {
    settingsStub.usageReportTokenScanCursor = '2026-05-20T06:30:00.000Z';
    historyMock.mockResolvedValue([
      makeEntry({ timestamp: '2026-05-20T06:29:00.000Z' }),
      makeEntry({ timestamp: '2026-05-20T06:30:00.000Z' }),
      makeEntry({ timestamp: '2026-05-20T06:31:00.000Z' }),
    ]);
    const result = await scanTranscriptsForTokenConsume();
    expect(result.queued).toBe(1);
    expect(result.newCursor).toBe('2026-05-20T06:31:00.000Z');
    const snap = await getUsageReportQueueSnapshot();
    expect(snap.tokenConsume).toHaveLength(1);
  });

  it('does not re-queue entries on the second scan when no new transcripts arrive', async () => {
    historyMock.mockResolvedValue([
      makeEntry({ timestamp: '2026-05-20T06:30:00.000Z', totalTokens: 100 }),
    ]);
    await scanTranscriptsForTokenConsume();
    const second = await scanTranscriptsForTokenConsume();
    expect(second.queued).toBe(0);
    const snap = await getUsageReportQueueSnapshot();
    expect(snap.tokenConsume).toHaveLength(1);
  });

  it('still advances cursor past unqueueable entries to avoid re-evaluation', async () => {
    historyMock.mockResolvedValue([
      makeEntry({ timestamp: '2026-05-20T06:30:00.000Z', totalTokens: 0 }),
      makeEntry({ timestamp: '2026-05-20T06:31:00.000Z', model: '' }),
    ]);
    const result = await scanTranscriptsForTokenConsume();
    expect(result.queued).toBe(0);
    // Cursor should still move so we don't keep re-evaluating these forever.
    expect(result.newCursor).toBe('2026-05-20T06:31:00.000Z');
  });
});
