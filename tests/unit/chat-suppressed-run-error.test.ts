import { describe, expect, it } from 'vitest';
import {
  isBackendRunFailureError,
  isSuppressedRunError,
  resolveRunFailureErrorMessage,
} from '@/stores/chat/helpers';

describe('isSuppressedRunError', () => {
  it('does not suppress backend abort errors', () => {
    expect(isSuppressedRunError('This operation was aborted')).toBe(false);
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

describe('backend run failure helpers', () => {
  it('detects backend abort errors', () => {
    expect(isBackendRunFailureError('This operation was aborted | This operation was aborted')).toBe(true);
    expect(isBackendRunFailureError('Request was aborted')).toBe(true);
  });

  it('maps backend abort errors to a user-facing message', () => {
    const resolved = resolveRunFailureErrorMessage('This operation was aborted');
    expect(resolved).not.toBe('This operation was aborted');
    expect(resolved.length).toBeGreaterThan(10);
  });
});
