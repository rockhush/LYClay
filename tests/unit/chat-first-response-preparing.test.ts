import { describe, expect, it } from 'vitest';
import { getChatWaitingMode, isFirstResponsePreparing } from '@/lib/chat-first-response-preparing';

describe('isFirstResponsePreparing', () => {
  it('is true when gateway running, sending, warmup not ready, and no stream payload', () => {
    expect(
      isFirstResponsePreparing({
        gatewayStatus: { state: 'running', warmupStatus: 'warming' },
        sending: true,
        streamingMessage: null,
        streamingText: '',
        streamingTools: [],
      }),
    ).toBe(true);
  });

  it('is false once warmup is ready', () => {
    expect(
      isFirstResponsePreparing({
        gatewayStatus: { state: 'running', warmupStatus: 'ready' },
        sending: true,
        streamingMessage: null,
        streamingText: '',
        streamingTools: [],
      }),
    ).toBe(false);
  });

  it('is false when assistant stream text exists', () => {
    expect(
      isFirstResponsePreparing({
        gatewayStatus: { state: 'running', warmupStatus: 'warming' },
        sending: true,
        streamingMessage: { role: 'assistant', content: 'hello' },
        streamingText: '',
        streamingTools: [],
      }),
    ).toBe(false);
  });

  it('stays true for empty or role-only stream placeholders', () => {
    expect(
      isFirstResponsePreparing({
        gatewayStatus: { state: 'running', warmupStatus: 'warming' },
        sending: true,
        streamingMessage: { role: 'assistant', content: undefined },
        streamingText: '',
        streamingTools: [],
      }),
    ).toBe(true);
  });

  it('is false for empty thinking blocks and tool calls', () => {
    expect(
      isFirstResponsePreparing({
        gatewayStatus: { state: 'running', warmupStatus: 'warming' },
        sending: true,
        streamingMessage: { role: 'assistant', content: [{ type: 'thinking' }] },
        streamingText: '',
        streamingTools: [],
      }),
    ).toBe(false);

    expect(
      isFirstResponsePreparing({
        gatewayStatus: { state: 'running', warmupStatus: 'warming' },
        sending: true,
        streamingMessage: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read' }] },
        streamingText: '',
        streamingTools: [],
      }),
    ).toBe(false);
  });

  it('reports stuck waiting mode when Gateway has a recent stuck-session diagnostic and no stream payload', () => {
    expect(
      getChatWaitingMode({
        gatewayStatus: {
          state: 'running',
          warmupStatus: 'ready',
          lastStuckSessionAt: Date.now(),
        },
        sending: true,
        streamingMessage: null,
        streamingText: '',
        streamingTools: [],
      }),
    ).toBe('stuck');
  });

  it('does not report stuck waiting mode once streaming payload exists', () => {
    expect(
      getChatWaitingMode({
        gatewayStatus: {
          state: 'running',
          warmupStatus: 'ready',
          lastStuckSessionAt: Date.now(),
        },
        sending: true,
        streamingMessage: { role: 'assistant', content: 'recovered' },
        streamingText: '',
        streamingTools: [],
      }),
    ).toBe('normal');
  });
});
