import { appendFile, readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLogObservabilityPipeline,
  isUserBlockingGatewayRpcMethod,
  observeGatewayNotificationForLog,
} from '@electron/utils/log-observability';
import * as logObservabilityModule from '@electron/utils/log-observability';

let tempDir: string;
const transcriptSessionId = '977e72a4-3784-488c-9919-2284dad5a1c3';

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'lyclaw-log-observability-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('log observability pipeline', () => {
  it('only treats chat.send as a user-blocking Gateway RPC failure', () => {
    expect(isUserBlockingGatewayRpcMethod('chat.send')).toBe(true);
    expect(isUserBlockingGatewayRpcMethod('sessions.abort')).toBe(false);
    expect(isUserBlockingGatewayRpcMethod('skills.status')).toBe(false);
    expect(isUserBlockingGatewayRpcMethod('health')).toBe(false);
  });

  it('rejects snapshots that do not explicitly block the current user', async () => {
    const send = vi.fn(async () => ({ ok: true as const }));
    const resolveSessionContext = vi.fn(async (sessionKey?: string) => ({ sessionKey }));
    const pipeline = createLogObservabilityPipeline({
      spoolDir: tempDir,
      now: () => '2026-07-28T12:00:00.000Z',
      identity: async () => ({ workNo: 'EMP00123', userName: '林一', identityMissingReason: null }),
      client: { send },
      resolveSessionContext,
      writerDelayMs: 1,
    });

    await pipeline.captureSnapshot({
      priority: 'p1',
      level: 'warn',
      source: 'security',
      eventName: 'security.audit_denied',
      errorCode: 'PATH_OUTSIDE_AUTHORIZED_ROOTS',
      message: 'filesystem deny',
      sessionKey: 'agent:main:security-event',
      status: 'denied',
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pipeline.queueSize()).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(resolveSessionContext).not.toHaveBeenCalled();
    await expect(readFile(join(tempDir, 'LYClaw-2026-07-28.snapshot.jsonl'), 'utf8')).rejects.toThrow();
  });

  it('adds ELK query fields to an admitted blocking snapshot', async () => {
    const send = vi.fn(async () => ({ ok: true as const }));
    const pipeline = createLogObservabilityPipeline({
      spoolDir: tempDir,
      now: () => '2026-07-28T12:01:00.000Z',
      identity: async () => ({ workNo: 'EMP00123', userName: '林一', identityMissingReason: null }),
      client: { send },
      resolveSessionContext: async (sessionKey) => ({ sessionKey, sessionId: transcriptSessionId }),
    });

    await pipeline.captureSnapshot({
      userImpact: 'blocking',
      operationKind: 'user_chat',
      failureStage: 'gateway_rpc',
      level: 'error',
      source: 'gateway',
      eventName: 'gateway.rpc_failed',
      errorCode: 'GATEWAY_RPC_FAILED',
      message: 'chat.send failed',
      method: 'chat.send',
      sessionKey: 'agent:main:session-1',
      status: 'failed',
    });

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0][0][0]).toEqual(expect.objectContaining({
      priority: 'p0',
      userImpact: 'blocking',
      operationKind: 'user_chat',
      failureStage: 'gateway_rpc',
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      occurrenceCount: 1,
      firstSeenAt: '2026-07-28T12:01:00.000Z',
      lastSeenAt: '2026-07-28T12:01:00.000Z',
      sessionKey: 'agent:main:session-1',
      sessionId: transcriptSessionId,
    }));
  });

  it('uses transcript UUID for fingerprint and falls back to sessionKey when resolution fails', async () => {
    const resolved = createLogObservabilityPipeline({
      spoolDir: tempDir,
      now: () => '2026-07-28T12:01:30.000Z',
      identity: async () => ({ workNo: '', userName: '', identityMissingReason: 'unavailable' }),
      resolveSessionContext: async (sessionKey) => ({ sessionKey, sessionId: transcriptSessionId }),
    });
    const unresolved = createLogObservabilityPipeline({
      spoolDir: tempDir,
      now: () => '2026-07-28T12:01:30.000Z',
      identity: async () => ({ workNo: '', userName: '', identityMissingReason: 'unavailable' }),
      resolveSessionContext: async (sessionKey) => ({ sessionKey }),
    });
    const input = {
      userImpact: 'blocking' as const,
      operationKind: 'user_chat' as const,
      failureStage: 'gateway_rpc',
      level: 'error',
      source: 'gateway',
      eventName: 'gateway.rpc_failed',
      errorCode: 'GATEWAY_RPC_FAILED',
      message: 'chat.send failed',
      method: 'chat.send',
      status: 'failed',
    };

    const resolvedA = await resolved.buildSnapshot({ ...input, sessionKey: 'agent:main:session-a' });
    const resolvedB = await resolved.buildSnapshot({ ...input, sessionKey: 'agent:main:session-b' });
    const unresolvedA = await unresolved.buildSnapshot({ ...input, sessionKey: 'agent:main:session-a' });
    const unresolvedB = await unresolved.buildSnapshot({ ...input, sessionKey: 'agent:main:session-b' });

    expect(resolvedA?.fingerprint).toBe(resolvedB?.fingerprint);
    expect(unresolvedA?.fingerprint).not.toBe(unresolvedB?.fingerprint);
    expect(unresolvedA).toEqual(expect.objectContaining({
      sessionKey: 'agent:main:session-a',
    }));
    expect(unresolvedA).not.toHaveProperty('sessionId');
  });

  it('merges the same blocking fingerprint for five minutes and reports its cumulative count', async () => {
    let nowIso = '2026-07-28T12:02:00.000Z';
    const send = vi.fn(async () => ({ ok: true as const }));
    const pipeline = createLogObservabilityPipeline({
      spoolDir: tempDir,
      now: () => nowIso,
      identity: async () => ({ workNo: 'EMP00123', userName: '林一', identityMissingReason: null }),
      client: { send },
    });
    const input = {
      userImpact: 'blocking' as const,
      operationKind: 'user_chat' as const,
      failureStage: 'gateway_rpc',
      level: 'error',
      source: 'gateway',
      eventName: 'gateway.rpc_failed',
      errorCode: 'GATEWAY_RPC_FAILED',
      message: 'chat.send failed',
      method: 'chat.send',
      sessionKey: 'agent:main:session-merge',
      status: 'failed',
    };

    await pipeline.captureSnapshot(input);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    nowIso = '2026-07-28T12:03:00.000Z';
    await pipeline.captureSnapshot(input);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(send).toHaveBeenCalledTimes(1);

    nowIso = '2026-07-28T12:07:00.000Z';
    await pipeline.captureSnapshot(input);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1][0][0]).toEqual(expect.objectContaining({
      fingerprint: send.mock.calls[0][0][0].fingerprint,
      occurrenceCount: 3,
      firstSeenAt: '2026-07-28T12:02:00.000Z',
      lastSeenAt: '2026-07-28T12:07:00.000Z',
    }));
  });

  it('bounds fingerprint aggregation state by evicting the least recently seen entry', async () => {
    let nowIso = '2026-07-28T12:10:00.000Z';
    const send = vi.fn(async () => ({ ok: true as const }));
    const pipeline = createLogObservabilityPipeline({
      spoolDir: tempDir,
      now: () => nowIso,
      identity: async () => ({ workNo: 'EMP00123', userName: '林一', identityMissingReason: null }),
      client: { send },
      maxFingerprintEntries: 1,
    });
    const capture = async (sessionKey: string) => await pipeline.captureSnapshot({
      userImpact: 'blocking',
      operationKind: 'user_chat',
      failureStage: 'gateway_rpc',
      level: 'error',
      source: 'gateway',
      eventName: 'gateway.rpc_failed',
      errorCode: 'GATEWAY_RPC_FAILED',
      message: 'chat.send failed',
      method: 'chat.send',
      sessionKey,
      status: 'failed',
    });

    await capture('session-a');
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    nowIso = '2026-07-28T12:10:01.000Z';
    await capture('session-b');
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    nowIso = '2026-07-28T12:10:02.000Z';
    await capture('session-a');
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
  });

  it('forwards unacked spool entries when Main initializes log forwarding', async () => {
    await writeFile(join(tempDir, 'LYClaw-2026-07-22.snapshot.jsonl'), `${JSON.stringify({
      documentType: 'error_snapshot',
      schemaVersion: 1,
      snapshotId: 'startup-retry',
      ts: '2026-07-22T08:00:00.000Z',
      priority: 'p0',
      userImpact: 'blocking',
      operationKind: 'app_runtime',
      failureStage: 'startup_retry',
      fingerprint: 'startup-retry-fingerprint',
      occurrenceCount: 1,
      firstSeenAt: '2026-07-22T08:00:00.000Z',
      lastSeenAt: '2026-07-22T08:00:00.000Z',
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
      userImpact: 'blocking',
      operationKind: 'user_chat',
      failureStage: 'gateway_transport',
      level: 'error',
      source: 'gateway',
      eventName: 'gateway.transport_unavailable',
      errorCode: 'GATEWAY_TRANSPORT_UNAVAILABLE',
      message: 'all transports failed',
    });

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0][0][0].eventName).toBe('gateway.transport_unavailable');
  });

  it('retries P0 spool persistence after a transient append failure', async () => {
    const send = vi.fn(async () => ({ ok: true as const }));
    const appendSnapshot = vi.fn(async (path: string, data: string, encoding: 'utf8') => {
      if (appendSnapshot.mock.calls.length === 1) throw new Error('temporary disk failure');
      await appendFile(path, data, encoding);
    });
    const pipeline = createLogObservabilityPipeline({
      spoolDir: tempDir,
      now: () => '2026-07-22T08:00:02.000Z',
      identity: async () => ({ workNo: 'EMP00123', userName: '林一', identityMissingReason: null }),
      client: { send },
      appendSnapshot,
      writerRetryDelayMs: 1,
    });

    await pipeline.captureSnapshot({
      userImpact: 'blocking',
      operationKind: 'user_chat',
      failureStage: 'gateway_rpc',
      level: 'error',
      source: 'gateway',
      eventName: 'gateway.rpc_failed',
      errorCode: 'GATEWAY_RPC_FAILED',
      message: 'chat.send failed',
      method: 'chat.send',
      sessionKey: 'agent:main:retry-persistence',
    });

    await vi.waitFor(() => expect(appendSnapshot).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(pipeline.queueSize()).toBe(0);
  });

  it('does not suppress the next occurrence when snapshot assembly fails before enqueue', async () => {
    const send = vi.fn(async () => ({ ok: true as const }));
    const identity = vi.fn()
      .mockRejectedValueOnce(new Error('identity unavailable'))
      .mockResolvedValueOnce({ workNo: 'EMP00123', userName: '林一', identityMissingReason: null });
    const pipeline = createLogObservabilityPipeline({
      spoolDir: tempDir,
      now: () => '2026-07-22T08:00:02.000Z',
      identity,
      client: { send },
    });
    const input = {
      userImpact: 'blocking' as const,
      operationKind: 'user_chat' as const,
      failureStage: 'gateway_rpc',
      level: 'error',
      source: 'gateway',
      eventName: 'gateway.rpc_failed',
      errorCode: 'GATEWAY_RPC_FAILED',
      message: 'chat.send failed',
      method: 'chat.send',
      sessionKey: 'agent:main:assembly-retry',
    };

    await expect(pipeline.captureSnapshot(input)).rejects.toThrow('identity unavailable');
    await pipeline.captureSnapshot(input);

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(identity).toHaveBeenCalledTimes(2);
  });

  it('does not forward P1 snapshots', async () => {
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

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(send).not.toHaveBeenCalled();
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
      userImpact: 'blocking',
      operationKind: 'user_chat',
      failureStage: 'gateway_rpc',
      level: 'error',
      source: 'gateway',
      eventName: 'gateway.rpc_timeout',
      component: 'gateway',
      errorCode: 'GATEWAY_RPC_TIMEOUT',
      message: 'rpc timeout',
      requestId: 'req-1',
    });

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
      userImpact: 'blocking',
      operationKind: 'host_api_operation',
      failureStage: 'host_api_route',
      level: 'error',
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

  it('does not capture an untracked Gateway agent lifecycle error', async () => {
    const send = vi.fn(async () => ({ ok: true as const }));
    const pipeline = createLogObservabilityPipeline({
      spoolDir: tempDir,
      now: () => '2026-07-23T10:00:00.000Z',
      identity: async () => ({ workNo: 'EMP00123', userName: '林一', identityMissingReason: null }),
      client: { send },
    });

    await observeGatewayNotificationForLog({
      jsonrpc: '2.0',
      method: 'agent',
      params: {
        runId: 'background-run',
        sessionKey: 'agent:cron:session-1',
        stream: 'lifecycle',
        data: { phase: 'error', error: 'background task failed' },
      },
    }, {
      pipeline,
      isTrackedUserRun: () => false,
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(send).not.toHaveBeenCalled();
  });

  it('does not capture a lifecycle error without an exact run id', async () => {
    const send = vi.fn(async () => ({ ok: true as const }));
    const pipeline = createLogObservabilityPipeline({
      spoolDir: tempDir,
      now: () => '2026-07-23T10:00:00.000Z',
      identity: async () => ({ workNo: 'EMP00123', userName: '林一', identityMissingReason: null }),
      client: { send },
    });

    await observeGatewayNotificationForLog({
      jsonrpc: '2.0',
      method: 'agent',
      params: {
        sessionKey: 'agent:main:shared-session',
        stream: 'lifecycle',
        data: { phase: 'error', error: 'background task failed' },
      },
    }, {
      pipeline,
      isTrackedUserRun: () => true,
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(send).not.toHaveBeenCalled();
  });

  it('captures a tracked Gateway agent lifecycle error as a blocking chat snapshot', async () => {
    const pipeline = createLogObservabilityPipeline({
      spoolDir: tempDir,
      now: () => '2026-07-23T10:00:00.000Z',
      identity: async () => ({ workNo: 'EMP00123', userName: '林一', identityMissingReason: null }),
      resolveSessionContext: async (sessionKey) => ({ sessionKey, sessionId: transcriptSessionId }),
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
    }, {
      pipeline,
      isTrackedUserRun: ({ runId, sessionKey }) => (
        runId === 'run-timeout-1' && sessionKey === 'agent:main:main'
      ),
    });

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
      priority: 'p0',
      userImpact: 'blocking',
      operationKind: 'user_chat',
      failureStage: 'agent_lifecycle',
      runId: 'run-timeout-1',
      sessionKey: 'agent:main:main',
      sessionId: transcriptSessionId,
      message: 'LLM request timed out. Logs: openclaw logs --follow',
    }));
    expect(raw).not.toContain('must not persist user prompt');
  });
});
