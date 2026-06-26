import { describe, expect, it } from 'vitest';
import {
  extractGatewayTimestampPrefixMs,
  formatTimestamp,
  normalizeTimestampToMs,
  resolveMessageDisplayTimestamp,
} from '@/pages/Chat/message-utils';
import type { RawMessage } from '@/stores/chat';

describe('normalizeTimestampToMs', () => {
  it('parses unix seconds and milliseconds', () => {
    expect(normalizeTimestampToMs(1_700_000_000)).toBe(1_700_000_000_000);
    expect(normalizeTimestampToMs(1_700_000_000_000)).toBe(1_700_000_000_000);
  });

  it('parses ISO timestamps from transcript jsonl entries', () => {
    const iso = '2026-06-16T12:53:39.123Z';
    expect(normalizeTimestampToMs(iso)).toBe(Date.parse(iso));
  });
});

describe('extractGatewayTimestampPrefixMs', () => {
  it('parses Gateway GMT+8 prefixes from message text', () => {
    const ms = extractGatewayTimestampPrefixMs('[Wed 2026-04-22 10:30 GMT+8] hello');
    expect(ms).toBe(Date.parse('2026-04-22T10:30:00+08:00'));
  });
});

describe('resolveMessageDisplayTimestamp', () => {
  it('prefers Gateway GMT+8 prefix over transcript timestamp field', () => {
    const message: RawMessage = {
      role: 'user',
      content: '[Wed 2026-04-22 10:30 GMT+8] hello',
      timestamp: Date.parse('2026-04-22T11:30:00+08:00') / 1000,
    };
    expect(resolveMessageDisplayTimestamp(message)).toBe(Date.parse('2026-04-22T10:30:00+08:00') / 1000);
  });
});

describe('formatTimestamp', () => {
  it('formats optimistic numeric timestamps consistently', () => {
    const seconds = 1_700_000_000;
    expect(formatTimestamp(seconds)).toBe(formatTimestamp(seconds * 1000));
  });
});
