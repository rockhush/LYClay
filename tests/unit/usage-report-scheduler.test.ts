import { describe, expect, it } from 'vitest';
import { computeMillisecondsUntilNextSlot } from '@electron/utils/reporting/scheduler';

describe('computeMillisecondsUntilNextSlot', () => {
  const slots = [
    { hour: 12, minute: 0 },
    { hour: 17, minute: 30 },
  ];

  it('targets the upcoming 12:00 slot when current time is before noon', () => {
    const now = new Date(2026, 4, 20, 9, 30, 0, 0);
    const ms = computeMillisecondsUntilNextSlot(now, slots);
    // 9:30 -> 12:00 == 2h 30m == 9_000_000 ms
    expect(ms).toBe(9_000_000);
  });

  it('targets 17:30 when between noon and 17:30', () => {
    const now = new Date(2026, 4, 20, 13, 0, 0, 0);
    const ms = computeMillisecondsUntilNextSlot(now, slots);
    // 13:00 -> 17:30 == 4h 30m
    expect(ms).toBe(4 * 3600 * 1000 + 30 * 60 * 1000);
  });

  it('rolls to the next-day 12:00 slot when after 17:30', () => {
    const now = new Date(2026, 4, 20, 18, 0, 0, 0);
    const ms = computeMillisecondsUntilNextSlot(now, slots);
    // 18:00 today -> 12:00 next day == 18h
    expect(ms).toBe(18 * 3600 * 1000);
  });

  it('never returns less than 1s to avoid hot-spinning when already at the slot', () => {
    const now = new Date(2026, 4, 20, 12, 0, 0, 0);
    const ms = computeMillisecondsUntilNextSlot(now, slots);
    // Strictly past noon → schedule next slot 17:30 (5h 30m).
    // The "<= now" branch in nextRunAt rolls forward by a day for the 12:00
    // slot, so the earliest slot becomes 17:30 same day.
    expect(ms).toBe(5 * 3600 * 1000 + 30 * 60 * 1000);
  });

});
