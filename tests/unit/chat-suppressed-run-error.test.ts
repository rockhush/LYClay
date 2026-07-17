import { describe, expect, it } from 'vitest';
import {
  isAbortErrorMessage,
  isBackendRunFailureError,
  isOutboundMediaPathFailedRunError,
  isSuppressedRunError,
  isSessionTranscriptLockBusyError,
  markUserAbort,
  resolveRunFailureErrorMessage,
  shouldSuppressPartialSuccessRunError,
  shouldTreatAbortAsUserStop,
} from '@/stores/chat/helpers';

const OUTBOUND_MEDIA_FAILED_ERROR =
  '~\\.openclaw\\media\\outbound\\3417b918-82ab-4617-9a24-f9bca52dec4-采购宣传易拉宝-无标题.jpg\\ failed';

describe('isOutboundMediaPathFailedRunError', () => {
  it('matches outbound media path failures from OpenClaw delivery noise', () => {
    expect(isOutboundMediaPathFailedRunError(OUTBOUND_MEDIA_FAILED_ERROR)).toBe(true);
    expect(isOutboundMediaPathFailedRunError(
      'C:\\Users\\demo\\.openclaw\\media\\outbound\\abc-photo.jpg failed',
    )).toBe(true);
  });

  it('does not match unrelated runtime errors', () => {
    expect(isOutboundMediaPathFailedRunError('Message failed')).toBe(false);
    expect(isOutboundMediaPathFailedRunError('context overflow')).toBe(false);
    expect(isOutboundMediaPathFailedRunError('404 Resource not found')).toBe(false);
  });
});

describe('shouldSuppressPartialSuccessRunError', () => {
  it('suppresses outbound media failures when the assistant already replied visibly', () => {
    expect(shouldSuppressPartialSuccessRunError(OUTBOUND_MEDIA_FAILED_ERROR, {
      role: 'assistant',
      content: [{ type: 'text', text: '已发送到您的钉钉（工号：11236149）。' }],
    })).toBe(true);
  });

  it('keeps outbound media failures when there is no visible assistant output', () => {
    expect(shouldSuppressPartialSuccessRunError(OUTBOUND_MEDIA_FAILED_ERROR, {
      role: 'assistant',
      content: [],
    })).toBe(false);
  });

  it('does not suppress unrelated terminal errors', () => {
    expect(shouldSuppressPartialSuccessRunError('context overflow', {
      role: 'assistant',
      content: [{ type: 'text', text: 'partial reply' }],
    })).toBe(false);
  });
});

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

  it('suppresses session transcript lock busy errors', () => {
    const legacyMessage = 'SessionTranscriptLockBusyError: Previous session response is still settling; transcript lock is still active for agent:main:abc.';
    const codedMessage = 'SESSION_TRANSCRIPT_LOCK_BUSY: The previous response is still being saved for this conversation.';

    expect(isSessionTranscriptLockBusyError(legacyMessage)).toBe(true);
    expect(isSessionTranscriptLockBusyError(codedMessage)).toBe(true);
    expect(isSuppressedRunError(legacyMessage)).toBe(true);
    expect(resolveRunFailureErrorMessage(codedMessage)).not.toContain('SESSION_TRANSCRIPT_LOCK_BUSY');
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
