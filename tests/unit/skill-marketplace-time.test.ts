import { describe, expect, it } from 'vitest';
import {
  isNewSkillByCreateTime,
  NEW_SKILL_WINDOW_MS,
  parseMarketplaceTimestamp,
} from '@/lib/skill-marketplace-time';

describe('parseMarketplaceTimestamp', () => {
  it('parses company API datetime strings', () => {
    expect(parseMarketplaceTimestamp('2026-06-11 10:14:10')).toBe(
      Date.parse('2026-06-11T10:14:10'),
    );
  });

  it('returns 0 for empty or invalid values', () => {
    expect(parseMarketplaceTimestamp('')).toBe(0);
    expect(parseMarketplaceTimestamp('not-a-date')).toBe(0);
  });
});

describe('isNewSkillByCreateTime', () => {
  const now = Date.parse('2026-08-06T12:00:00');

  it('returns true when create_time is within 3 days', () => {
    expect(isNewSkillByCreateTime('2026-08-04 10:00:00', now)).toBe(true);
    expect(isNewSkillByCreateTime('2026-08-06 11:59:59', now)).toBe(true);
  });

  it('returns false when create_time is older than 3 days', () => {
    expect(isNewSkillByCreateTime('2026-08-03 11:59:59', now)).toBe(false);
  });

  it('returns false when create_time is missing or invalid', () => {
    expect(isNewSkillByCreateTime(undefined, now)).toBe(false);
    expect(isNewSkillByCreateTime('', now)).toBe(false);
    expect(isNewSkillByCreateTime('invalid', now)).toBe(false);
  });

  it('returns false when create_time is in the future', () => {
    expect(isNewSkillByCreateTime('2026-08-07 00:00:00', now)).toBe(false);
  });

  it('uses a configurable window', () => {
    const oneDayMs = 24 * 60 * 60 * 1000;
    expect(isNewSkillByCreateTime('2026-08-05 12:00:00', now, oneDayMs)).toBe(true);
    expect(isNewSkillByCreateTime('2026-08-04 11:59:59', now, oneDayMs)).toBe(false);
  });

  it('treats exactly 3 days as still new', () => {
    const createTime = new Date(now - NEW_SKILL_WINDOW_MS).toISOString();
    expect(isNewSkillByCreateTime(createTime, now)).toBe(true);
  });
});
