import { describe, expect, it } from 'vitest';
import {
  isAbortErrorMessage,
  isBackendRunFailureError,
  isSuppressedRunError,
  markUserAbort,
  resolveRunFailureErrorMessage,
  shouldTreatAbortAsUserStop,
} from '@/stores/chat/helpers';

describe('isSuppressedRunError', () => {
  it('suppresses generic abort errors during the user-stop window', () => {
    markUserAbort();
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

describe('abort error helpers', () => {
  it('detects generic abort strings', () => {
    expect(isAbortErrorMessage('This operation was aborted | This operation was aborted')).toBe(true);
    expect(isAbortErrorMessage('Request was aborted')).toBe(true);
    expect(isAbortErrorMessage('context overflow')).toBe(false);
  });

  it('treats abort as user stop when the abort window is open', () => {
    markUserAbort();
    expect(shouldTreatAbortAsUserStop('This operation was aborted')).toBe(true);
  });

  it('maps system-side abort errors to a dedicated message', () => {
    const resolved = resolveRunFailureErrorMessage('This operation was aborted');
    expect(resolved).not.toBe('This operation was aborted');
    expect(resolved).not.toContain('后端 Agent 服务已停止响应');
    expect(resolved.length).toBeGreaterThan(5);
  });

  it('only treats backendRunStopped copy as backend failure', () => {
    expect(isBackendRunFailureError('This operation was aborted')).toBe(false);
  });
});
