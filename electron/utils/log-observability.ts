import { join } from 'node:path';
import type { JsonRpcNotification } from '../gateway/protocol';
import { logger } from './logger';
import { getLogsDir } from './paths';
import { createLogContextBuffer, type LogContextBuffer, type LogContextEventInput } from './log-context-buffer';
import {
  buildErrorSnapshot,
  captureErrorSnapshot,
  classifySnapshotPriority,
  createSnapshotWriteQueue,
  type ErrorSnapshotInput,
  type SnapshotPriority,
  type SnapshotWriteQueue,
} from './error-snapshot';
import { LogForwarder, SnapshotSpoolWriter, createDisabledLogForwardClient, createTcpLogForwardClient, type LogForwardClient, type LogServerReachability } from './log-forwarder';
import { resolveLogIdentityContext, type LogIdentityContext } from './log-identity-context';

export type LogSnapshotCaptureInput = Omit<ErrorSnapshotInput, 'priority'> & {
  priority?: SnapshotPriority;
};

export interface LogObservabilityPipeline {
  contextBuffer: LogContextBuffer;
  recordEvent(event: LogContextEventInput): void;
  captureSnapshot(input: LogSnapshotCaptureInput): Promise<void>;
  buildSnapshot(input: LogSnapshotCaptureInput): Promise<ReturnType<typeof buildErrorSnapshot> extends Promise<infer T> ? T : never>;
  flushSpool(priority?: SnapshotPriority): Promise<void>;
  flushForwarder(): Promise<void>;
  queueSize(): number;
  getForwarderReachability(): LogServerReachability;
}

export function createLogObservabilityPipeline(options: {
  spoolDir: string;
  now?: () => string;
  identity?: () => Promise<LogIdentityContext>;
  client?: LogForwardClient;
  writerDelayMs?: number;
  windowMs?: number;
  maxEvents?: number;
  maxQueueItems?: number;
  maxQueueBytes?: number;
}): LogObservabilityPipeline {
  const now = options.now ?? (() => new Date().toISOString());
  const identity = options.identity ?? resolveLogIdentityContext;
  const contextBuffer = createLogContextBuffer({
    windowMs: options.windowMs ?? 30_000,
    maxEvents: options.maxEvents ?? 500,
  });
  const queue: SnapshotWriteQueue = createSnapshotWriteQueue({
    maxItems: options.maxQueueItems ?? 1000,
    maxBytes: options.maxQueueBytes ?? 8 * 1024 * 1024,
  });
  const writer = new SnapshotSpoolWriter({ spoolDir: options.spoolDir, queue, now });
  const forwarder = new LogForwarder({
    spoolDir: options.spoolDir,
    client: options.client ?? createDisabledLogForwardClient(),
    now,
  });
  let writerTimer: NodeJS.Timeout | null = null;

  async function flushWriterAndForward(): Promise<void> {
    await writer.flush();
    await forwarder.flushOnce();
  }

  function scheduleWriter(priority: SnapshotPriority): void {
    if (priority === 'p0') {
      if (writerTimer) {
        clearTimeout(writerTimer);
        writerTimer = null;
      }
      void flushWriterAndForward().catch((error) => {
        logger.warn('[log.pipeline] Failed to persist or forward P0 snapshot', { error: String(error) });
      });
      return;
    }

    if (writerTimer) return;
    writerTimer = setTimeout(() => {
      writerTimer = null;
      void flushWriterAndForward().catch((error) => {
        logger.warn('[log.pipeline] Failed to persist or forward P1 snapshot', { error: String(error) });
      });
    }, options.writerDelayMs ?? 5_000);
  }

  function normalizeInput(input: LogSnapshotCaptureInput): ErrorSnapshotInput {
    return {
      ...input,
      priority: input.priority ?? classifySnapshotPriority(input),
    };
  }

  return {
    contextBuffer,
    recordEvent(event) {
      contextBuffer.record(event);
    },
    async captureSnapshot(input) {
      await captureErrorSnapshot({
        queue,
        scheduleWriter,
        contextBuffer,
        identity,
        now,
        input: normalizeInput(input),
      });
    },
    async buildSnapshot(input) {
      return await buildErrorSnapshot({
        now,
        identity,
        contextBuffer,
        input: normalizeInput(input),
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export async function observeGatewayNotificationForLog(
  notification: JsonRpcNotification,
  pipeline = getLogObservabilityPipeline(),
): Promise<void> {
  if (notification.method !== 'agent') return;

  const params = asRecord(notification.params);
  const data = asRecord(params?.data);
  const stream = stringValue(params?.stream);
  const phase = stringValue(data?.phase ?? params?.phase);
  if (stream !== 'lifecycle' || phase !== 'error') return;

  const runId = stringValue(params?.runId ?? data?.runId);
  const sessionId = stringValue(params?.sessionKey ?? data?.sessionKey);
  const message = stringValue(data?.error ?? params?.error ?? data?.errorMessage ?? params?.errorMessage)
    ?? 'Gateway agent run failed before reply';

  pipeline.recordEvent({
    eventName: 'gateway.agent_lifecycle',
    component: 'gateway',
    source: 'chat',
    runId,
    sessionId,
    status: 'failed',
    metadata: {
      stream,
      phase,
    },
  });

  await pipeline.captureSnapshot({
    level: 'error',
    source: 'chat',
    eventName: 'chat.run_error',
    component: 'gateway-agent',
    errorCode: 'CHAT_RUN_ERROR',
    message,
    runId,
    sessionId,
    status: 'failed',
    metadata: {
      stream,
      phase,
    },
  });
}
