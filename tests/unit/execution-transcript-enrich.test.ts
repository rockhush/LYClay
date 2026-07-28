import { describe, expect, it } from 'vitest';
import {
  parseReportDateTimeLocal,
  pickBestUsageEntry,
  needsTokenEnrichment,
} from '@electron/utils/reporting/execution-transcript-enrich';
import type { TokenUsageHistoryEntry } from '@electron/utils/token-usage-core';
import type { ExecutionRecord } from '@electron/utils/reporting/types';

function usageEntry(
  timestamp: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
): TokenUsageHistoryEntry {
  return {
    timestamp,
    sessionId: 'session-1',
    agentId: 'main',
    model: 'auto',
    usageStatus: 'available',
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens: 0,
    totalTokens: inputTokens + outputTokens + cacheReadTokens,
  };
}

describe('execution transcript enrich helpers', () => {
  it('parses local report datetime strings', () => {
    const ms = parseReportDateTimeLocal('2026-07-27 14:20:00');
    expect(ms).not.toBeNull();
    const date = new Date(ms!);
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(6);
    expect(date.getDate()).toBe(27);
    expect(date.getHours()).toBe(14);
    expect(date.getMinutes()).toBe(20);
  });

  it('picks the usage entry closest to ended_at within tolerance', () => {
    const entries = [
      usageEntry('2026-07-27T06:10:00.000Z', 100, 10, 0),
      usageEntry('2026-07-27T06:20:00.000Z', 1071, 1060, 26400),
    ];
    const endedMs = Date.parse('2026-07-27T06:20:05.000Z');
    const startedMs = Date.parse('2026-07-27T06:19:00.000Z');
    const match = pickBestUsageEntry(entries, startedMs, endedMs);
    expect(match?.inputTokens).toBe(1071);
    expect(match?.outputTokens).toBe(1060);
    expect(match?.cacheReadTokens).toBe(26400);
  });

  it('detects when execution records need token enrichment', () => {
    const complete = {
      input_tokens: 1,
      output_tokens: 2,
      cache_read_tokens: 3,
      status: 'success',
    } as ExecutionRecord;
    const allZero = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      status: 'success',
    } as ExecutionRecord;
    const incomplete = {
      input_tokens: 1,
      status: 'success',
    } as ExecutionRecord;
    expect(needsTokenEnrichment(complete)).toBe(false);
    expect(needsTokenEnrichment(allZero)).toBe(true);
    expect(needsTokenEnrichment(incomplete)).toBe(true);
  });
});
