import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { JsonRpcNotification } from '../gateway/protocol';
import { logger } from './logger';
import { getLogsDir } from './paths';
import { createLogContextBuffer, type LogContextBuffer, type LogContextEventInput } from './log-context-buffer';
import {
  buildErrorSnapshot,
  captureErrorSnapshot,
  createSnapshotWriteQueue,
  type ErrorSnapshotInput,
  type SnapshotOperationKind,
  type SnapshotPriority,
  type SnapshotWriteQueue,
} from './error-snapshot';
import { LogForwarder, SnapshotSpoolWriter, createDisabledLogForwardClient, createTcpLogForwardClient, type LogForwardClient, type LogServerReachability } from './log-forwarder';
import { resolveLogIdentityContext, type LogIdentityContext } from './log-identity-context';
import { resolveLogSessionContext, type LogSessionContext } from './log-session-context';

export type LogSnapshotCaptureInput = Omit<
  ErrorSnapshotInput,
  'priority' | 'userImpact' | 'operationKind' | 'failureStage' | 'fingerprint' | 'occurrenceCount' | 'firstSeenAt' | 'lastSeenAt'
> & {
  priority?: SnapshotPriority;
  userImpact?: 'blocking';
  operationKind?: SnapshotOperationKind;
  failureStage?: string;
};

export interface LogObservabilityPipeline {
  contextBuffer: LogContextBuffer;
  recordEvent(event: LogContextEventInput): void;
  captureSnapshot(input: LogSnapshotCaptureInput): Promise<void>;
  buildSnapshot(input: LogSnapshotCaptureInput): Promise<(ReturnType<typeof buildErrorSnapshot> extends Promise<infer T> ? T : never) | null>;
  flushSpool(priority?: SnapshotPriority): Promise<void>;
  flushForwarder(): Promise<void>;
  queueSize(): number;
  getForwarderReachability(): LogServerReachability;
}

export function createLogObservabilityPipeline(options: {
  spoolDir: string;
  now?: () => string;
  identity?: () => Promise<LogIdentityContext>;
  resolveSessionContext?: (sessionKey: string | undefined) => Promise<LogSessionContext>;
  client?: LogForwardClient;
  writerDelayMs?: number;
  windowMs?: number;
  maxEvents?: number;
  maxQueueItems?: number;
  maxQueueBytes?: number;
  dedupeWindowMs?: number;
  maxFingerprintEntries?: number;
  appendSnapshot?: (path: string, data: string, encoding: 'utf8') => Promise<void>;
  writerRetryDelayMs?: number;
}): LogObservabilityPipeline {
  const now = options.now ?? (() => new Date().toISOString());
  const identity = options.identity ?? resolveLogIdentityContext;
  const resolveSessionContext = options.resolveSessionContext ?? resolveLogSessionContext;
  const contextBuffer = createLogContextBuffer({
    windowMs: options.windowMs ?? 30_000,
    maxEvents: options.maxEvents ?? 500,
  });
  const queue: SnapshotWriteQueue = createSnapshotWriteQueue({
    maxItems: options.maxQueueItems ?? 1000,
    maxBytes: options.maxQueueBytes ?? 8 * 1024 * 1024,
  });
  const writer = new SnapshotSpoolWriter({
    spoolDir: options.spoolDir,
    queue,
    now,
    append: options.appendSnapshot,
  });
  const forwarder = new LogForwarder({
    spoolDir: options.spoolDir,
    client: options.client ?? createDisabledLogForwardClient(),
    now,
  });
  let writerTimer: NodeJS.Timeout | null = null;
  const dedupeWindowMs = options.dedupeWindowMs ?? 5 * 60_000;
  const maxFingerprintEntries = options.maxFingerprintEntries ?? 1000;
  const fingerprints = new Map<string, {
    occurrenceCount: number;
    firstSeenAt: string;
    lastSeenAt: string;
    lastEmittedAtMs: number;
    emissionPending: boolean;
  }>();

  async function flushWriterAndForward(): Promise<void> {
    await writer.flush();
    await forwarder.flushOnce();
  }

  function scheduleWriterRetry(priority: SnapshotPriority): void {
    if (writerTimer) return;
    writerTimer = setTimeout(() => {
      writerTimer = null;
      void flushWriterAndForward().catch((error) => {
        logger.warn('[log.pipeline] Snapshot persistence retry failed', { error: String(error) });
        scheduleWriterRetry(priority);
      });
    }, options.writerRetryDelayMs ?? 5_000);
    writerTimer.unref?.();
  }

  function scheduleWriter(priority: SnapshotPriority): void {
    if (priority === 'p0') {
      if (writerTimer) {
        clearTimeout(writerTimer);
        writerTimer = null;
      }
      void flushWriterAndForward().catch((error) => {
        logger.warn('[log.pipeline] Failed to persist or forward P0 snapshot', { error: String(error) });
        scheduleWriterRetry(priority);
      });
      return;
    }

    if (writerTimer) return;
    writerTimer = setTimeout(() => {
      writerTimer = null;
      void flushWriterAndForward().catch((error) => {
        logger.warn('[log.pipeline] Failed to persist or forward P1 snapshot', { error: String(error) });
        scheduleWriterRetry(priority);
      });
    }, options.writerDelayMs ?? 5_000);
  }

  function fingerprintFor(input: LogSnapshotCaptureInput): string {
    return createHash('sha256')
      .update(JSON.stringify([
        input.eventName,
        input.errorCode,
        input.method ?? '',
        input.route ?? '',
        input.sessionId ?? input.sessionKey ?? '',
      ]))
      .digest('hex');
  }

  function evictOldestFingerprint(): void {
    if (fingerprints.size <= maxFingerprintEntries) return;
    let oldestKey: string | null = null;
    let oldestTime = Number.POSITIVE_INFINITY;
    for (const [key, value] of fingerprints) {
      const lastSeen = Date.parse(value.lastSeenAt);
      const time = Number.isFinite(lastSeen) ? lastSeen : 0;
      if (time < oldestTime) {
        oldestKey = key;
        oldestTime = time;
      }
    }
    if (oldestKey) fingerprints.delete(oldestKey);
  }

  async function enrichSessionContext(input: LogSnapshotCaptureInput): Promise<LogSnapshotCaptureInput> {
    if (!input.sessionKey) return input;
    try {
      const context = await resolveSessionContext(input.sessionKey);
      return {
        ...input,
        sessionKey: context.sessionKey ?? input.sessionKey,
        sessionId: context.sessionId,
      };
    } catch {
      return {
        ...input,
        sessionKey: input.sessionKey,
        sessionId: undefined,
      };
    }
  }

  function hasBlockingAdmission(input: LogSnapshotCaptureInput): boolean {
    return input.userImpact === 'blocking' && Boolean(input.operationKind) && Boolean(input.failureStage);
  }

  function admitInput(input: LogSnapshotCaptureInput, trackOccurrence = true): ErrorSnapshotInput | null {
    if (!hasBlockingAdmission(input) || !input.operationKind || !input.failureStage) return null;

    const observedAt = now();
    const observedAtMs = Date.parse(observedAt);
    const fingerprint = fingerprintFor(input);
    const existing = fingerprints.get(fingerprint);
    const occurrenceCount = (existing?.occurrenceCount ?? 0) + 1;
    const aggregate = {
      occurrenceCount,
      firstSeenAt: existing?.firstSeenAt ?? observedAt,
      lastSeenAt: observedAt,
      lastEmittedAtMs: existing?.lastEmittedAtMs ?? Number.NEGATIVE_INFINITY,
      emissionPending: existing?.emissionPending ?? false,
    };

    if (trackOccurrence) {
      fingerprints.set(fingerprint, aggregate);
      evictOldestFingerprint();
      if (aggregate.emissionPending) return null;
      if (Number.isFinite(observedAtMs) && observedAtMs - aggregate.lastEmittedAtMs < dedupeWindowMs) {
        return null;
      }
      aggregate.emissionPending = true;
    }

    return {
      ...input,
      priority: 'p0',
      userImpact: 'blocking',
      operationKind: input.operationKind,
      failureStage: input.failureStage,
      fingerprint,
      occurrenceCount,
      firstSeenAt: aggregate.firstSeenAt,
      lastSeenAt: aggregate.lastSeenAt,
    };
  }

  return {
    contextBuffer,
    recordEvent(event) {
      contextBuffer.record(event);
    },
    async captureSnapshot(input) {
      if (!hasBlockingAdmission(input)) return;
      const admitted = admitInput(await enrichSessionContext(input));
      if (!admitted) return;
      try {
        await captureErrorSnapshot({
          queue,
          scheduleWriter,
          contextBuffer,
          identity,
          now,
          input: admitted,
        });
        const aggregate = fingerprints.get(admitted.fingerprint);
        if (aggregate) {
          const emittedAtMs = Date.parse(admitted.lastSeenAt);
          aggregate.lastEmittedAtMs = Number.isFinite(emittedAtMs) ? emittedAtMs : Date.now();
          aggregate.emissionPending = false;
        }
      } catch (error) {
        const aggregate = fingerprints.get(admitted.fingerprint);
        if (aggregate) aggregate.emissionPending = false;
        throw error;
      }
    },
    async buildSnapshot(input) {
      if (!hasBlockingAdmission(input)) return null;
      const admitted = admitInput(await enrichSessionContext(input), false);
      if (!admitted) return null;
      return await buildErrorSnapshot({
        now,
        identity,
        contextBuffer,
        input: admitted,
      });
    },
    async flushSpool(priority) {
      if (writerTimer) {
        clearTimeout(writerTimer);
        writerTimer = null;
      }
      await writer.flush(priority);
    },
    async flushForwarder() {
      await forwarder.flushOnce();
    },
    queueSize() {
      return queue.size();
    },
    getForwarderReachability() {
      return forwarder.getReachability();
    },
  };
}

let defaultPipeline: LogObservabilityPipeline | null = null;

export function getLogObservabilityPipeline(): LogObservabilityPipeline {
  if (!defaultPipeline) {
    defaultPipeline = createLogObservabilityPipeline({
      spoolDir: join(getLogsDir(), 'snapshots'),
      client: createTcpLogForwardClient(),
    });
  }
  return defaultPipeline;
}

export function recordLogEvent(event: LogContextEventInput): void {
  getLogObservabilityPipeline().recordEvent(event);
}

export async function captureLogErrorSnapshot(input: LogSnapshotCaptureInput): Promise<void> {
  await getLogObservabilityPipeline().captureSnapshot(input);
}

export async function flushLogSnapshots(priority?: SnapshotPriority): Promise<void> {
  await getLogObservabilityPipeline().flushSpool(priority);
}

export async function flushLogForwarder(): Promise<void> {
  await getLogObservabilityPipeline().flushForwarder();
}

export function initializeLogForwarding(
  pipeline = getLogObservabilityPipeline(),
): void {
  void pipeline.flushForwarder().catch((error) => {
    logger.warn('[log.pipeline] Failed to forward persisted snapshots during startup', {
      error: String(error),
    });
  });
}

export function isUserBlockingGatewayRpcMethod(method: string): boolean {
  return method === 'chat.send';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export async function observeGatewayNotificationForLog(
  notification: JsonRpcNotification,
  options: {
    pipeline?: LogObservabilityPipeline;
    isTrackedUserRun?: (context: { runId?: string; sessionKey?: string }) => boolean;
  } = {},
): Promise<void> {
  const pipeline = options.pipeline ?? getLogObservabilityPipeline();
  if (notification.method !== 'agent') return;

  const params = asRecord(notification.params);
  const data = asRecord(params?.data);
  const stream = stringValue(params?.stream);
  const phase = stringValue(data?.phase ?? params?.phase);
  if (stream !== 'lifecycle' || phase !== 'error') return;

  const runId = stringValue(params?.runId ?? data?.runId);
  const sessionKey = stringValue(params?.sessionKey ?? data?.sessionKey);
  const message = stringValue(data?.error ?? params?.error ?? data?.errorMessage ?? params?.errorMessage)
    ?? 'Gateway agent run failed before reply';

  pipeline.recordEvent({
    eventName: 'gateway.agent_lifecycle',
    component: 'gateway',
    source: 'chat',
    runId,
    sessionId: sessionKey,
    status: 'failed',
    metadata: {
      stream,
      phase,
    },
  });

  if (!runId || !options.isTrackedUserRun?.({ runId, sessionKey })) return;

  await pipeline.captureSnapshot({
    userImpact: 'blocking',
    operationKind: 'user_chat',
    failureStage: 'agent_lifecycle',
    level: 'error',
    source: 'chat',
    eventName: 'chat.run_error',
    component: 'gateway-agent',
    errorCode: 'CHAT_RUN_ERROR',
    message,
    runId,
    sessionKey,
    status: 'failed',
    metadata: {
      stream,
      phase,
    },
  });
}
