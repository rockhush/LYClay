import { describe, expect, it } from 'vitest';
import {
  inferScheduleIntervalMs,
  isTransientCronError,
  previousCronExprOccurrenceMs,
  previousScheduleOccurrenceMs,
} from '@electron/gateway/cron-schedule';

const TZ = 'Asia/Shanghai';

/** Build an absolute timestamp from Shanghai wall-clock (UTC+8, no DST). */
function shanghai(year: number, month: number, day: number, hour: number, minute: number): number {
  return Date.UTC(year, month - 1, day, hour - 8, minute, 0);
}

describe('previousCronExprOccurrenceMs', () => {
  it('finds the most recent daily 17:00 occurrence later the same day', () => {
    const now = shanghai(2026, 6, 23, 18, 30);
    expect(previousCronExprOccurrenceMs('0 17 * * *', TZ, now)).toBe(shanghai(2026, 6, 23, 17, 0));
  });

  it('rolls back to the previous day when before today\'s time', () => {
    const now = shanghai(2026, 6, 23, 9, 0);
    expect(previousCronExprOccurrenceMs('0 17 * * *', TZ, now)).toBe(shanghai(2026, 6, 22, 17, 0));
  });

  it('handles 16:30 daily schedules', () => {
    const now = shanghai(2026, 6, 23, 16, 45);
    expect(previousCronExprOccurrenceMs('30 16 * * *', TZ, now)).toBe(shanghai(2026, 6, 23, 16, 30));
  });

  it('handles weekly schedules (Monday 09:00)', () => {
    // 2026-06-23 is a Tuesday; previous Monday is 2026-06-22.
    const now = shanghai(2026, 6, 23, 10, 0);
    expect(previousCronExprOccurrenceMs('0 9 * * 1', TZ, now)).toBe(shanghai(2026, 6, 22, 9, 0));
  });

  it('handles monthly schedules (1st at 09:00)', () => {
    const now = shanghai(2026, 6, 23, 10, 0);
    expect(previousCronExprOccurrenceMs('0 9 1 * *', TZ, now)).toBe(shanghai(2026, 6, 1, 9, 0));
  });

  it('handles step minutes (every 5 minutes)', () => {
    const now = shanghai(2026, 6, 23, 10, 7);
    expect(previousCronExprOccurrenceMs('*/5 * * * *', TZ, now)).toBe(shanghai(2026, 6, 23, 10, 5));
  });

  it('returns null for malformed expressions', () => {
    expect(previousCronExprOccurrenceMs('not a cron', TZ, Date.now())).toBeNull();
    expect(previousCronExprOccurrenceMs('0 17 * *', TZ, Date.now())).toBeNull();
  });
});

describe('previousScheduleOccurrenceMs', () => {
  it('supports cron schedule objects', () => {
    const now = shanghai(2026, 6, 23, 18, 0);
    expect(previousScheduleOccurrenceMs({ kind: 'cron', expr: '0 17 * * *', tz: TZ }, now))
      .toBe(shanghai(2026, 6, 23, 17, 0));
  });

  it('supports every schedules', () => {
    const anchor = shanghai(2026, 6, 23, 0, 0);
    const now = anchor + 3 * 3_600_000 + 5 * 60_000; // 3h05m later
    expect(previousScheduleOccurrenceMs({ kind: 'every', everyMs: 3_600_000, anchorMs: anchor }, now))
      .toBe(anchor + 3 * 3_600_000);
  });

  it('supports one-shot at schedules only when in the past', () => {
    const at = '2026-06-23T09:00:00+08:00';
    const atMs = Date.parse(at);
    expect(previousScheduleOccurrenceMs({ kind: 'at', at }, atMs + 1000)).toBe(atMs);
    expect(previousScheduleOccurrenceMs({ kind: 'at', at }, atMs - 1000)).toBeNull();
  });
});

describe('inferScheduleIntervalMs', () => {
  it('returns ~24h for a daily cron', () => {
    const now = shanghai(2026, 6, 23, 18, 0);
    expect(inferScheduleIntervalMs({ kind: 'cron', expr: '0 17 * * *', tz: TZ }, now)).toBe(24 * 3_600_000);
  });

  it('returns 5 minutes for a */5 cron', () => {
    const now = shanghai(2026, 6, 23, 10, 7);
    expect(inferScheduleIntervalMs({ kind: 'cron', expr: '*/5 * * * *', tz: TZ }, now)).toBe(5 * 60_000);
  });

  it('returns everyMs for every schedules', () => {
    expect(inferScheduleIntervalMs({ kind: 'every', everyMs: 3_600_000 }, Date.now())).toBe(3_600_000);
  });
});

describe('isTransientCronError', () => {
  it('matches cold-start and transport failures', () => {
    expect(isTransientCronError('isolated agent setup timed out before runner start')).toBe(true);
    expect(isTransientCronError('isolated agent run stalled before execution start (last phase: context-engine)')).toBe(true);
    expect(isTransientCronError('run failed: RPC timeout: cron.run')).toBe(true);
    expect(isTransientCronError('request timed out')).toBe(true);
    expect(isTransientCronError('gateway not running')).toBe(true);
    expect(isTransientCronError('job interrupted by gateway restart')).toBe(true);
  });

  it('does not match permanent configuration errors', () => {
    expect(isTransientCronError('channel is required')).toBe(false);
    expect(isTransientCronError('agent "foo" not found')).toBe(false);
    expect(isTransientCronError('no default model configured')).toBe(false);
    expect(isTransientCronError('')).toBe(false);
    expect(isTransientCronError(null)).toBe(false);
  });
});
