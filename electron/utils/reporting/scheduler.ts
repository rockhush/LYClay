/**
 * Daily scheduler for usage-report uploads.
 *
 * Fires `flushUsageReports` at 12:00 and 17:30 in local time. The schedule
 * is purely setTimeout-driven (no cron), so we re-arm immediately after
 * each fire and never accumulate setInterval drift. When the OS suspends
 * (sleep/hibernate) past a slot, we cover it via the same "flush on home
 * entry" path the renderer already calls — see App.tsx hook.
 *
 * Time slots are local-time as the spec requested ("系统时间每天中午十二点
 * 和下午五点半"), matching how an end user would expect "noon" and "5:30 PM"
 * to behave on their machine.
 */

import { logger } from '../logger';
import { flushUsageReports } from './uploader';

interface DailySlot {
  hour: number;
  minute: number;
}

const DAILY_SLOTS: DailySlot[] = [
  { hour: 12, minute: 0 },
  { hour: 17, minute: 30 },
];

let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = true;

function nextRunAt(now: Date, slots: DailySlot[]): Date {
  let earliest: Date | null = null;
  for (const slot of slots) {
    const candidate = new Date(now);
    candidate.setHours(slot.hour, slot.minute, 0, 0);
    if (candidate.getTime() <= now.getTime()) {
      candidate.setDate(candidate.getDate() + 1);
    }
    if (!earliest || candidate.getTime() < earliest.getTime()) {
      earliest = candidate;
    }
  }
  // Fallback should never happen with a non-empty slot list, but TypeScript
  // can't prove that — return now+1d as a defensive default.
  if (!earliest) {
    const fallback = new Date(now);
    fallback.setDate(fallback.getDate() + 1);
    return fallback;
  }
  return earliest;
}

/** Exported for tests. */
export function computeMillisecondsUntilNextSlot(now: Date, slots: DailySlot[] = DAILY_SLOTS): number {
  const next = nextRunAt(now, slots);
  return Math.max(1_000, next.getTime() - now.getTime());
}

function scheduleNext(): void {
  if (stopped) return;
  const delay = computeMillisecondsUntilNextSlot(new Date());
  // Math.min cap at 24h so a wall-clock drift / DST skip does not leave us
  // sleeping for an absurdly long timer (Node clamps timers > ~24.8d).
  const safeDelay = Math.min(delay, 24 * 60 * 60 * 1000);
  timer = setTimeout(() => {
    void runSlot();
  }, safeDelay);
  if (typeof timer === 'object' && timer && 'unref' in timer && typeof (timer as { unref?: () => void }).unref === 'function') {
    // Don't keep the event loop alive solely for the report scheduler.
    (timer as { unref: () => void }).unref();
  }
  logger.debug(`[UsageReport] scheduler: next slot in ${Math.round(safeDelay / 1000)}s`);
}

async function runSlot(): Promise<void> {
  try {
    await flushUsageReports('daily-slot');
  } catch (error) {
    logger.warn('[UsageReport] scheduler slot flush threw:', error);
  } finally {
    scheduleNext();
  }
}

export function startUsageReportScheduler(): void {
  if (!stopped) return;
  stopped = false;
  scheduleNext();
  logger.info('[UsageReport] scheduler started (12:00 / 17:30 local)');
}

export function stopUsageReportScheduler(): void {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
