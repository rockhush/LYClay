import { describe, expect, it } from 'vitest';
import { isSuppressedRunError } from '@/stores/chat/helpers';

describe('isSuppressedRunError', () => {
  it('suppresses user abort errors', () => {
    expect(isSuppressedRunError('This operation was aborted')).toBe(true);
  });

  it('suppresses embedded session transcript lock race errors', () => {
    expect(isSuppressedRunError(
      'session file changed while embedded prompt lock was released: C:\\Users\\demo\\.openclaw\\agents\\main\\sessions\\abc.jsonl',
    )).toBe(true);
  });

  it('does not suppress actionable runtime errors', () => {
    expect(isSuppressedRunError('context overflow')).toBe(false);
    expect(isSuppressedRunError('Network access denied: https://example.com')).toBe(false);
  });
});
