/**
 * Two backend formats live side by side:
 *   - skill-download / skill-invoke use `date` field, "YYYY-MM-DD HH:MM"
 *   - token-consume uses `consumeTime` field, "YYYY-MM-DD HH:MM:SS"
 *
 * Centralized here so renderer-side recorders and main-process schedulers
 * use the exact same formatter — drift between two implementations would
 * cause silent record rejections.
 */

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function toDate(input: Date | number | string): Date {
  return typeof input === 'string' || typeof input === 'number' ? new Date(input) : input;
}

/** "YYYY-MM-DD HH:MM" — used by skill-download / skill-invoke `date` field. */
export function formatReportDate(input: Date | number | string): string {
  const d = toDate(input);
  if (Number.isNaN(d.getTime())) {
    // Fallback to "now" rather than corrupting the queue with NaN-formatted
    // strings that the backend would reject for the rest of the batch.
    return formatReportDate(new Date());
  }
  return [
    d.getFullYear(),
    '-',
    pad(d.getMonth() + 1),
    '-',
    pad(d.getDate()),
    ' ',
    pad(d.getHours()),
    ':',
    pad(d.getMinutes()),
  ].join('');
}

/** "YYYY-MM-DD HH:MM:SS" — used by token-consume `consumeTime` field. */
export function formatReportDateTime(input: Date | number | string): string {
  const d = toDate(input);
  if (Number.isNaN(d.getTime())) {
    return formatReportDateTime(new Date());
  }
  return [
    d.getFullYear(),
    '-',
    pad(d.getMonth() + 1),
    '-',
    pad(d.getDate()),
    ' ',
    pad(d.getHours()),
    ':',
    pad(d.getMinutes()),
    ':',
    pad(d.getSeconds()),
  ].join('');
}

/** Validate "YYYY-MM-DD HH:MM" (skill endpoints). */
export function isValidReportDate(value: unknown): value is string {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value);
}

/** Validate "YYYY-MM-DD HH:MM:SS" (token-consume endpoint). */
export function isValidReportDateTime(value: unknown): value is string {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value);
}
