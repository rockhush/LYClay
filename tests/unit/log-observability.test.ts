import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLogObservabilityPipeline,
  observeGatewayNotificationForLog,
} from '@electron/utils/log-observability';
import * as logObservabilityModule from '@electron/utils/log-observability';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'lyclaw-log-observability-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('log observability pipeline', () => {
  it('forwards unacked spool entries when Main initializes log forwarding', async () => {
    await writeFile(join(tempDir, 'LYClaw-2026-07-22.snapshot.jsonl'), `${JSON.stringify({
      documentType: 'error_snapshot',
      schemaVersion: 1,
      snapshotId: 'startup-retry',
      ts: '2026-07-22T08:00:00.000Z',
      priority: 'p0',
      level: 'error',
      source: 'gateway',
      eventName: 'gateway.startup_retry',
      component: 'gateway',
      errorCode: 'GATEWAY_STARTUP_RETRY',
      message: 'retry persisted snapshot',
      workNo: '',
      userName: '',
      identityMissingReason: 'unavailable',
      recentEvents: [],
      metadata: {},
      truncated: false,
    })}\n`);
    const send = vi.fn(async () => ({ ok: true as const }));
    const pipeline = createLogObservabilityPipeline({
      spoolDir: tempDir,
      now: () => '2026-07-22T08:00:02.000Z',
      client: { send },
    });
    const initializeLogForwarding = Reflect.get(logObservabilityModule, 'initializeLogForwarding');
    expect(initializeLogForwarding).toBeTypeOf('function');

    initializeLogForwarding(pipeline);

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0][0][0].snapshotId).toBe('startup-retry');
  });

  it('forwards a P0 snapshot after it is persisted without blocking capture', async () => {
    const send = vi.fn(async () => ({ ok: true as const }));
    const pipeline = createLogObservabilityPipeline({
      spoolDir: tempDir,
      now: () => '2026-07-22T08:00:02.000Z',
      identity: async () => ({ workNo: 'EMP00123', userName: '林一', identityMissingReason: null }),
      client: { send },
    });

    await pipeline.captureSnapshot({
      priority: 'p0',
      level: 'error',
      source: 'gateway',
      eventName: 'gateway.transport_unavailable',
      errorCode: 'GATEWAY_TRANSPORT_UNAVAILABLE',
      message: 'all transports failed',
    });

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0][0][0].eventName).toBe('gateway.transport_unavailable');
  });

  it('forwards P1 snapshots after the deferred spool drain', async () => {
    const send = vi.fn(async () => ({ ok: true as const }));
    const pipeline = createLogObservabilityPipeline({
      spoolDir: tempDir,
      now: () => '2026-07-22T08:00:02.000Z',
      identity: async () => ({ workNo: 'EMP00123', userName: '林一', identityMissingReason: null }),
      client: { send },
      writerDelayMs: 1,
    });

    await pipeline.captureSnapshot({
      priority: 'p1',
      level: 'warn',
      source: 'hostapi',
      eventName: 'hostapi.request_error',
      errorCode: 'HOSTAPI_ROUTE_FAILED',
      message: 'route failed',
    });

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0][0][0].priority).toBe('p1');
  });

  it('records context, captures complete snapshot, and schedules disk spool without caller awaiting writer', async () => {
    const pipeline = createLogObservabilityPipeline({
      spoolDir: tempDir,
      now: () => '2026-07-22T08:00:02.000Z',
      identity: async () => ({ workNo: 'EMP00123', userName: '林一', identityMissingReason: null }),
      writerDelayMs: 1,
    });

    pipeline.recordEvent({
      ts: '2026-07-22T08:00:01.000Z',
      eventName: 'gateway.rpc',
      component: 'gateway',
      status: 'timeout',
      requestId: 'req-1',
      metadata: { prompt: 'do not persist', safe: 'kept' },
    });

    await pipeline.captureSnapshot({
      priority: 'p1',
      level: 'error',
      source: 'gateway',
      eventName: 'gateway.rpc_timeout',
      component: 'gateway',
      errorCode: 'GATEWAY_RPC_TIMEOUT',
      message: 'rpc timeout',
      requestId: 'req-1',
    });

    expect(pipeline.queueSize()).toBe(1);
    await pipeline.flushSpool();

    const raw = await readFile(join(tempDir, 'LYClaw-2026-07-22.snapshot.jsonl'), 'utf8');
    expect(raw).toContain('"documentType":"error_snapshot"');
    expect(raw).toContain('"snapshotId"');
    expect(raw).toContain('"recentEvents"');
    expect(raw).not.toContain('do not persist');
  });

  it('keeps ELK HTTP behind a disabled replaceable client by default', async () => {
    const pipeline = createLogObservabilityPipeline({
      spoolDir: tempDir,
      now: () => '2026-07-22T08:00:02.000Z',
      identity: async () => ({ workNo: '', userName: '', identityMissingReason: 'missing_dingtalk_user' }),
    });

    await expect(pipeline.flushForwarder()).resolves.toBeUndefined();
    expect(pipeline.getForwarderReachability()).toBe('unknown');

    const client = { send: vi.fn(async () => ({ ok: true as const, ackId: 'ack-1' })) };
    const enabled = createLogObservabilityPipeline({
      spoolDir: tempDir,
      now: () => '2026-07-22T08:00:02.000Z',
      identity: async () => ({ workNo: '', userName: '', identityMissingReason: 'missing_dingtalk_user' }),
      client,
    });

    await enabled.captureSnapshot({
      priority: 'p1',
      level: 'warn',
      source: 'hostapi',
      eventName: 'hostapi.request_error',
      errorCode: 'HOSTAPI_ROUTE_FAILED',
      message: 'route failed',
    });
    await enabled.flushSpool();
    await enabled.flushForwarder();

    expect(client.send).toHaveBeenCalledTimes(1);
    expect(enabled.getForwarderReachability()).toBe('reachable');
  });

  it('captures Gateway agent lifecycle error notifications as chat run snapshots', async () => {
    const pipeline = createLogObservabilityPipeline({
      spoolDir: tempDir,
      now: () => '2026-07-23T10:00:00.000Z',
      identity: async () => ({ workNo: 'EMP00123', userName: '林一', identityMissingReason: null }),
    });

    await observeGatewayNotificationForLog({
      jsonrpc: '2.0',
      method: 'agent',
      params: {
        runId: 'run-timeout-1',
        sessionKey: 'agent:main:main',
        stream: 'lifecycle',
        data: {
          phase: 'error',
          error: 'LLM request timed out. Logs: openclaw logs --follow',
          prompt: 'must not persist user prompt',
        },
      },
    }, pipeline);

    const spoolPath = join(tempDir, 'LYClaw-2026-07-23.snapshot.jsonl');
    await vi.waitFor(async () => {
      await expect(readFile(spoolPath, 'utf8')).resolves.toContain('"chat.run_error"');
    });

    const raw = await readFile(spoolPath, 'utf8');
    const snapshot = JSON.parse(raw.trim());
    expect(snapshot).toEqual(expect.objectContaining({
      documentType: 'error_snapshot',
      source: 'chat',
      eventName: 'chat.run_error',
      errorCode: 'CHAT_RUN_ERROR',
      runId: 'run-timeout-1',
      sessionId: 'agent:main:main',
      message: 'LLM request timed out. Logs: openclaw logs --follow',
    }));
    expect(raw).not.toContain('must not persist user prompt');
  });
});
