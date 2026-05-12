import { describe, expect, it } from 'vitest';
import { isFirstResponsePreparing } from '@/lib/chat-first-response-preparing';

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
});
