import { describe, expect, it } from 'vitest';
import { hasRunningExecInLines } from '../../electron/gateway/session-exec-liveness';

describe('session-exec-liveness', () => {
  it('detects running exec tool results in transcript tail', () => {
    const lines = [
      {
        type: 'message',
        message: {
          role: 'toolResult',
          toolName: 'exec',
          toolCallId: 'call-1',
          details: { status: 'running' },
          content: [{ type: 'text', text: 'Command still running (session cool-haven)' }],
        },
      },
    ];

    expect(hasRunningExecInLines(lines)).toBe(true);
  });

  it('ignores completed exec tool results', () => {
    const lines = [
      {
        type: 'message',
        message: {
          role: 'toolResult',
          toolName: 'exec',
          toolCallId: 'call-1',
          details: { status: 'completed' },
          content: [{ type: 'text', text: 'done' }],
        },
      },
    ];

    expect(hasRunningExecInLines(lines)).toBe(false);
  });
});
