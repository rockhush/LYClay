import { describe, expect, it } from 'vitest';
import { detectCronJobRunUpdates } from '@electron/gateway/cron-supervisor';

describe('detectCronJobRunUpdates', () => {
  it('seeds baseline on first poll without emitting updates', () => {
    const result = detectCronJobRunUpdates(
      {},
      [
        { id: 'job-a', state: { lastRunAtMs: 1_000 } },
        { id: 'job-b', state: { lastRunAtMs: 2_000 } },
      ],
      false,
    );

    expect(result.initialized).toBe(true);
    expect(result.updatedJobIds).toEqual([]);
    expect(result.nextRunAtMs).toEqual({ 'job-a': 1_000, 'job-b': 2_000 });
  });

  it('detects when gateway advances lastRunAtMs for a job', () => {
    const baseline = detectCronJobRunUpdates(
      {},
      [{ id: 'job-a', state: { lastRunAtMs: 1_000 } }],
      false,
    );

    const result = detectCronJobRunUpdates(
      baseline.nextRunAtMs,
      [{ id: 'job-a', state: { lastRunAtMs: 1_722_000_000_000 } }],
      baseline.initialized,
    );

    expect(result.updatedJobIds).toEqual(['job-a']);
    expect(result.nextRunAtMs['job-a']).toBe(1_722_000_000_000);
  });

  it('ignores unchanged or regressed lastRunAtMs values', () => {
    const baseline = detectCronJobRunUpdates(
      {},
      [{ id: 'job-a', state: { lastRunAtMs: 5_000 } }],
      false,
    );

    const unchanged = detectCronJobRunUpdates(
      baseline.nextRunAtMs,
      [{ id: 'job-a', state: { lastRunAtMs: 5_000 } }],
      baseline.initialized,
    );
    expect(unchanged.updatedJobIds).toEqual([]);

    const regressed = detectCronJobRunUpdates(
      unchanged.nextRunAtMs,
      [{ id: 'job-a', state: { lastRunAtMs: 4_000 } }],
      unchanged.initialized,
    );
    expect(regressed.updatedJobIds).toEqual([]);
  });
});
