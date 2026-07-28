import { describe, expect, it } from 'vitest';
import { createLogContextBuffer } from '@electron/utils/log-context-buffer';

describe('log context buffer', () => {
  it('keeps only recent sanitized allowlist fields and correlates by request/session/model', () => {
    const buffer = createLogContextBuffer({ windowMs: 30_000, maxEvents: 50 });

    buffer.record({
      ts: '2026-07-22T08:00:00.000Z',
      eventName: 'hostapi.request',
      component: 'hostapi',
      route: '/api/providers?token=secret',
      method: 'GET',
      status: 'ok',
      statusCode: 200,
      durationMs: 12,
      requestId: 'req-1',
      metadata: {
        prompt: 'do not keep prompt body',
        safe: 'kept',
        authorization: 'Bearer abcdefghijklmnopqrstuvwxyz123456',
      },
      content: 'raw body must be ignored',
    });
    buffer.record({
      ts: '2026-07-22T08:00:05.000Z',
      eventName: 'gateway.rpc',
      component: 'gateway',
      method: 'chat.send',
      status: 'timeout',
      durationMs: 30_000,
      requestId: 'req-2',
      runId: 'run-1',
      sessionId: 'session-1',
      modelId: 'deepseek-chat',
      baseUrl: 'https://user:pass@example.com/v1/chat?api_key=secret',
    });
    buffer.record({
      ts: '2026-07-22T07:59:00.000Z',
      eventName: 'old.event',
      component: 'old',
      requestId: 'req-2',
    });

    const events = buffer.collect({
      at: '2026-07-22T08:00:10.000Z',
      requestId: 'req-2',
      sessionId: 'session-1',
      modelId: 'deepseek-chat',
      baseUrl: 'https://example.com/v1/chat',
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(expect.objectContaining({
      eventName: 'gateway.rpc',
      requestId: 'req-2',
      runId: 'run-1',
      sessionId: 'session-1',
      modelId: 'deepseek-chat',
      baseUrl: 'https://example.com/v1/chat',
    }));
    expect(JSON.stringify(events)).not.toContain('raw body');
    expect(JSON.stringify(events)).not.toContain('api_key');
    expect(JSON.stringify(events)).not.toContain('user:pass');
  });
});
