/**
 * Pure, dependency-free cron-schedule helpers used by the cron supervisor.
 *
 * These functions are side-effect-free so they can be unit tested in isolation
 * and reused without pulling in gateway state. The supervisor uses them to:
 *   1. decide whether a job's most recent scheduled occurrence was missed
 *      (machine asleep / powered off / app not running) and needs a catch-up;
 *   2. classify a failure as a transient cold-start/transport error that is
 *      worth an automatic retry (vs. a permanent misconfiguration).
 *
 * Timezone handling uses Intl.DateTimeFormat so a job created in one timezone
 * still resolves to the correct wall-clock instant even if the OS timezone or
 * DST differs.
 */

export type GatewayCronScheduleLike = {
  kind?: string;
  expr?: string;
  everyMs?: number;
  anchorMs?: number;
  at?: string;
  tz?: string;
};

const MINUTE_MS = 60_000;

function floorToMinute(ms: number): number {
  return Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number; // 0-59
  weekday: number; // 0-6 (Sun=0)
}

/** Read the wall-clock parts of an absolute timestamp in a given timezone. */
function getZonedParts(ts: number, tz: string): ZonedParts {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  });
  const map: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(ts))) {
    map[part.type] = part.value;
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour) % 24,
    minute: Number(map.minute),
    weekday: WEEKDAY_INDEX[map.weekday] ?? 0,
  };
}

/** Offset (ms) between the wall-clock-as-UTC and the real instant for `tz`. */
function getTimezoneOffsetMs(ts: number, tz: string): number {
  const zp = getZonedParts(ts, tz);
  const asUtc = Date.UTC(zp.year, zp.month - 1, zp.day, zp.hour, zp.minute, 0);
  return asUtc - floorToMinute(ts);
}

/** Convert a wall-clock time in `tz` to an absolute timestamp (ms). */
function zonedWallClockToTs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offset1 = getTimezoneOffsetMs(guess, tz);
  let ts = guess - offset1;
  const offset2 = getTimezoneOffsetMs(ts, tz);
  if (offset2 !== offset1) {
    ts = guess - offset2;
  }
  return ts;
}

interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

function parseField(raw: string, min: number, max: number): Set<number> | null {
  const result = new Set<number>();
  for (const piece of raw.split(',')) {
    const token = piece.trim();
    if (!token) return null;

    let rangePart = token;
    let step = 1;
    const slashIdx = token.indexOf('/');
    if (slashIdx >= 0) {
      rangePart = token.slice(0, slashIdx);
      step = Number(token.slice(slashIdx + 1));
      if (!Number.isInteger(step) || step <= 0) return null;
    }

    let lo = min;
    let hi = max;
    if (rangePart === '*') {
      // keep full range
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-');
      lo = Number(a);
      hi = Number(b);
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) return null;
    } else {
      const single = Number(rangePart);
      if (!Number.isInteger(single)) return null;
      lo = single;
      hi = single;
    }

    if (lo < min || hi > max || lo > hi) return null;
    for (let value = lo; value <= hi; value += step) {
      result.add(value);
    }
  }
  return result.size > 0 ? result : null;
}

/** Parse a standard 5-field cron expression. Returns null if unsupported. */
function parseCronExpr5(expr: string): CronFields | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const minutes = parseField(parts[0], 0, 59);
  const hours = parseField(parts[1], 0, 23);
  const daysOfMonth = parseField(parts[2], 1, 31);
  const months = parseField(parts[3], 1, 12);
  // Day-of-week supports 0-7 (both 0 and 7 mean Sunday).
  const daysOfWeek = parseField(parts[4].replace(/7/g, '0'), 0, 6);

  if (!minutes || !hours || !daysOfMonth || !months || !daysOfWeek) return null;

  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    domRestricted: parts[2].trim() !== '*',
    dowRestricted: parts[4].trim() !== '*',
  };
}

function dayMatches(fields: CronFields, zp: ZonedParts): boolean {
  if (!fields.months.has(zp.month)) return false;

  const domOk = fields.daysOfMonth.has(zp.day);
  const dowOk = fields.daysOfWeek.has(zp.weekday);

  // Vixie cron semantics: when both DOM and DOW are restricted, match if EITHER
  // matches; otherwise honor whichever field is restricted.
  if (fields.domRestricted && fields.dowRestricted) return domOk || dowOk;
  if (fields.domRestricted) return domOk;
  if (fields.dowRestricted) return dowOk;
  return true;
}

/**
 * Most recent cron occurrence at or before `nowMs` for a 5-field expression
 * evaluated in `tz`. Returns null when none is found within the lookback window
 * or the expression is unsupported.
 */
export function previousCronExprOccurrenceMs(
  expr: string,
  tz: string,
  nowMs: number,
): number | null {
  const fields = parseCronExpr5(expr);
  if (!fields) return null;

  const cutoff = floorToMinute(nowMs);
  const hoursDesc = [...fields.hours].sort((a, b) => b - a);
  const minutesDesc = [...fields.minutes].sort((a, b) => b - a);

  // Walk back day-by-day, bounded to ~13 months to cover sparse monthly rules.
  let probe = cutoff;
  for (let dayOffset = 0; dayOffset <= 400; dayOffset += 1) {
    const zp = getZonedParts(probe, tz);
    if (dayMatches(fields, zp)) {
      for (const hour of hoursDesc) {
        for (const minute of minutesDesc) {
          const ts = zonedWallClockToTs(zp.year, zp.month, zp.day, hour, minute, tz);
          if (ts <= cutoff) {
            return ts;
          }
        }
      }
    }
    probe -= 24 * 60 * MINUTE_MS;
  }

  return null;
}

/**
 * Most recent scheduled occurrence (<= nowMs) for a gateway cron schedule
 * object. Supports `cron`, `every`, and `at` kinds. Returns null when it cannot
 * be determined.
 */
export function previousScheduleOccurrenceMs(
  schedule: GatewayCronScheduleLike | undefined,
  nowMs: number,
): number | null {
  if (!schedule || typeof schedule !== 'object') return null;
  const tz = schedule.tz || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  if (schedule.kind === 'cron' && typeof schedule.expr === 'string') {
    return previousCronExprOccurrenceMs(schedule.expr, tz, nowMs);
  }

  if (schedule.kind === 'every' && typeof schedule.everyMs === 'number' && schedule.everyMs > 0) {
    const anchor = typeof schedule.anchorMs === 'number' ? schedule.anchorMs : 0;
    if (nowMs < anchor) return null;
    const elapsed = nowMs - anchor;
    return anchor + Math.floor(elapsed / schedule.everyMs) * schedule.everyMs;
  }

  if (schedule.kind === 'at' && typeof schedule.at === 'string') {
    const atMs = Date.parse(schedule.at);
    if (!Number.isFinite(atMs)) return null;
    return atMs <= nowMs ? atMs : null;
  }

  return null;
}

/**
 * Approximate the cadence (interval between consecutive occurrences) of a
 * schedule near `nowMs`. Used to avoid catch-up firing for high-frequency
 * schedules (e.g. every-5-minutes) where a missed tick is irrelevant. Returns
 * Infinity for one-shot (`at`) schedules, null when unknown.
 */
export function inferScheduleIntervalMs(
  schedule: GatewayCronScheduleLike | undefined,
  nowMs: number,
): number | null {
  if (!schedule || typeof schedule !== 'object') return null;

  if (schedule.kind === 'every' && typeof schedule.everyMs === 'number' && schedule.everyMs > 0) {
    return schedule.everyMs;
  }
  if (schedule.kind === 'at') {
    return Number.POSITIVE_INFINITY;
  }
  if (schedule.kind === 'cron' && typeof schedule.expr === 'string') {
    const tz = schedule.tz || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const prev = previousCronExprOccurrenceMs(schedule.expr, tz, nowMs);
    if (prev == null) return null;
    const prevPrev = previousCronExprOccurrenceMs(schedule.expr, tz, prev - MINUTE_MS);
    if (prevPrev == null) return Number.POSITIVE_INFINITY;
    return prev - prevPrev;
  }
  return null;
}

const TRANSIENT_CRON_ERROR_PATTERN = new RegExp(
  [
    'isolated agent setup timed out',
    'stalled before execution',
    'timed out before runner',
    'runner start failed',
    'runner start timed out',
    'context-engine',
    '(?:rpc|request)\\b[^\\n]*\\btimed out',
    'rpc timeout',
    'gateway\\b[^\\n]*(?:not running|unavailable|disconnected|not connected)',
    'gateway stopped',
    'network error',
    'fetch failed',
    'econnrefused',
    'enotfound',
    'socket hang up',
    'job interrupted by gateway restart',
  ].join('|'),
  'i',
);

/**
 * Whether a cron failure looks transient (cold-start / transport) and is worth
 * an automatic retry, as opposed to a permanent misconfiguration such as a
 * missing channel or unknown agent.
 */
export function isTransientCronError(error: string | undefined | null): boolean {
  if (!error) return false;
  return TRANSIENT_CRON_ERROR_PATTERN.test(error);
}
