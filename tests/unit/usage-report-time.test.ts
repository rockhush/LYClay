import { describe, expect, it } from 'vitest';
import {
  formatReportDate,
  formatReportDateTime,
  isValidReportDate,
  isValidReportDateTime,
} from '@electron/utils/reporting/time';

describe('formatReportDate', () => {
  it('formats Date objects in local "YYYY-MM-DD HH:MM"', () => {
    const d = new Date(2026, 4, 20, 23, 7, 31, 999); // local-time inputs
    expect(formatReportDate(d)).toBe('2026-05-20 23:07');
  });

  it('zero-pads single-digit month/day/hour/minute', () => {
    const d = new Date(2026, 0, 9, 1, 5);
    expect(formatReportDate(d)).toBe('2026-01-09 01:05');
  });

  it('accepts numeric epoch ms input', () => {
    const ms = new Date(2026, 5, 1, 12, 30).getTime();
    expect(formatReportDate(ms)).toBe('2026-06-01 12:30');
  });

  it('falls back to current time when input is invalid', () => {
    const result = formatReportDate('not-a-date');
    expect(isValidReportDate(result)).toBe(true);
  });
});

describe('isValidReportDate', () => {
  it('accepts the canonical YYYY-MM-DD HH:MM format', () => {
    expect(isValidReportDate('2026-05-20 23:20')).toBe(true);
    expect(isValidReportDate('2026-12-31 00:00')).toBe(true);
  });

  it('rejects ISO timestamps and other shapes', () => {
    expect(isValidReportDate('2026-05-20T23:20:00')).toBe(false);
    expect(isValidReportDate('2026-5-20 23:20')).toBe(false);
    expect(isValidReportDate('')).toBe(false);
    expect(isValidReportDate(undefined)).toBe(false);
  });
});

describe('formatReportDateTime', () => {
  it('formats Date objects in local "YYYY-MM-DD HH:MM:SS"', () => {
    const d = new Date(2026, 4, 20, 14, 29, 7, 999);
    expect(formatReportDateTime(d)).toBe('2026-05-20 14:29:07');
  });

  it('zero-pads seconds', () => {
    const d = new Date(2026, 0, 9, 1, 5, 9);
    expect(formatReportDateTime(d)).toBe('2026-01-09 01:05:09');
  });

  it('falls back to current time when input is invalid', () => {
    expect(isValidReportDateTime(formatReportDateTime('not-a-date'))).toBe(true);
  });
});

describe('isValidReportDateTime', () => {
  it('accepts only YYYY-MM-DD HH:MM:SS', () => {
    expect(isValidReportDateTime('2026-05-20 14:29:00')).toBe(true);
    expect(isValidReportDateTime('2026-05-20 14:29')).toBe(false);
    expect(isValidReportDateTime('2026-05-20T14:29:00')).toBe(false);
  });
});
