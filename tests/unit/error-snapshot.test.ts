import { describe, expect, it, vi } from 'vitest';
import {
  buildErrorSnapshot,
  captureErrorSnapshot,
  createSnapshotWriteQueue,
  isElkEligibleSnapshot,
  sanitizeBaseUrl,
} from '@electron/utils/error-snapshot';
import { createLogContextBuffer } from '@electron/utils/log-context-buffer';

const providerToken = 'sk-abcdefghijklmnopqrstuvwxyz1234567890';
const bearerToken = 'Bearer abcdefghijklmnopqrstuvwxyz123456';

describe('error snapshot', () => {
  it('sanitizes baseUrl down to protocol, host, and base path', () => {
    expect(sanitizeBaseUrl('https://user:pass@example.com/v1/chat/completions?api_key=secret#frag')).toBe('https://example.com/v1/chat/completions');
    expect(sanitizeBaseUrl('not a url')).toBeNull();
  });

  it('builds a complete redacted error_snapshot document with correlated recent events', async () => {
    const contextBuffer = createLogContextBuffer({ windowMs: 30_000, maxEvents: 50 });
    contextBuffer.record({
      ts: '2026-07-22T08:00:01.000Z',
      eventName: 'gateway.rpc',
      component: 'gateway',
      method: 'chat.send',
      status: 'timeout',
      durationMs: 30_000,
      requestId: 'req-1',
      runId: 'run-1',
      sessionId: 'agent:main:session-1',
      modelId: 'deepseek-chat',
      baseUrl: 'https://provider.example.com/v1?api_key=secret',
      metadata: {
        result: 'timeout',
        prompt: 'must not persist prompt body',
      },
    });

    const snapshot = await buildErrorSnapshot({
      now: () => '2026-07-22T08:00:02.000Z',
      identity: async () => ({
        workNo: 'EMP00123',
        userName: '林一',
        identityMissingReason: null,
      }),
      contextBuffer,
      input: {
        priority: 'p0',
        userImpact: 'blocking',
        operationKind: 'user_chat',
        failureStage: 'provider_request',
        fingerprint: 'snapshot-fingerprint',
        occurrenceCount: 2,
        firstSeenAt: '2026-07-22T08:00:00.000Z',
        lastSeenAt: '2026-07-22T08:00:02.000Z',
        level: 'error',
        source: 'chat',
        eventName: 'chat.run_unavailable',
        component: 'gateway-manager',
        errorCode: 'CHAT_RUN_UNAVAILABLE',
        message: `model failed with ${providerToken} and ${bearerToken}`,
        requestId: 'req-1',
        runId: 'run-1',
        sessionKey: 'agent:main:session-1',
        sessionId: '977e72a4-3784-488c-9919-2284dad5a1c3',
        modelId: 'deepseek-chat',
        baseUrl: 'https://user:pass@provider.example.com/v1?api_key=secret',
        method: 'chat.send',
        route: '/gateway/rpc?token=secret',
        status: 'failed',
        statusCode: 504,
        durationMs: 30_000,
        retryCount: 2,
        fallbackUsed: true,
        recovered: false,
        metadata: {
          downstream: 'nginx',
          response: 'must not persist model response body',
          authorization: bearerToken,
        },
      },
    });

    expect(snapshot).toEqual(expect.objectContaining({
      documentType: 'error_snapshot',
      schemaVersion: 1,
      snapshotId: expect.any(String),
      ts: '2026-07-22T08:00:02.000Z',
      priority: 'p0',
      userImpact: 'blocking',
      operationKind: 'user_chat',
      failureStage: 'provider_request',
      fingerprint: 'snapshot-fingerprint',
      occurrenceCount: 2,
      firstSeenAt: '2026-07-22T08:00:00.000Z',
      lastSeenAt: '2026-07-22T08:00:02.000Z',
      level: 'error',
      source: 'chat',
      eventName: 'chat.run_unavailable',
      component: 'gateway-manager',
      errorCode: 'CHAT_RUN_UNAVAILABLE',
      workNo: 'EMP00123',
      userName: '林一',
      identityMissingReason: null,
      requestId: 'req-1',
      runId: 'run-1',
      sessionKey: 'agent:main:session-1',
      sessionId: '977e72a4-3784-488c-9919-2284dad5a1c3',
      modelId: 'deepseek-chat',
      baseUrl: 'https://provider.example.com/v1',
      method: 'chat.send',
      route: '/gateway/rpc',
      status: 'failed',
      statusCode: 504,
      durationMs: 30_000,
      retryCount: 2,
      fallbackUsed: true,
      recovered: false,
      truncated: false,
    }));
    expect(snapshot.recentEvents).toHaveLength(1);
    expect(isElkEligibleSnapshot(snapshot)).toBe(true);
    expect(isElkEligibleSnapshot({ ...snapshot, sessionKey: 123 })).toBe(false);
    expect(JSON.stringify(snapshot)).not.toContain(providerToken);
    expect(JSON.stringify(snapshot)).not.toContain(bearerToken);
    expect(JSON.stringify(snapshot)).not.toContain('prompt body');
    expect(JSON.stringify(snapshot)).not.toContain('model response body');
    expect(JSON.stringify(snapshot)).not.toContain('api_key');
    expect(JSON.stringify(snapshot)).not.toContain('user:pass');
  });

  it('captureErrorSnapshot enqueues without awaiting writer work', async () => {
    const queue = createSnapshotWriteQueue({ maxItems: 1000, maxBytes: 8 * 1024 * 1024 });
    const scheduleWriter = vi.fn();
    const contextBuffer = createLogContextBuffer({ windowMs: 30_000, maxEvents: 50 });

    await captureErrorSnapshot({
      queue,
      scheduleWriter,
      contextBuffer,
      identity: async () => ({ workNo: '', userName: '', identityMissingReason: 'missing_dingtalk_user' }),
      now: () => '2026-07-22T08:00:02.000Z',
      input: {
        priority: 'p0',
        userImpact: 'blocking',
        operationKind: 'host_api_operation',
        failureStage: 'host_api_route',
        fingerprint: 'capture-fingerprint',
        occurrenceCount: 1,
        firstSeenAt: '2026-07-22T08:00:02.000Z',
        lastSeenAt: '2026-07-22T08:00:02.000Z',
        level: 'error',
        source: 'hostapi',
        eventName: 'hostapi.request_error',
        errorCode: 'HOSTAPI_ROUTE_FAILED',
        message: 'route failed',
      },
    });

    expect(queue.size()).toBe(1);
    expect(scheduleWriter).toHaveBeenCalledTimes(1);
    expect(scheduleWriter).toHaveBeenCalledWith('p0');
  });
});
