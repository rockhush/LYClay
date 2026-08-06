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
  type SnapshotUserImpact,
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
  userImpact?: 'blocking' | 'non-blocking';
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

  function hasAdmission(input: LogSnapshotCaptureInput): boolean {
    if (!input.operationKind || !input.failureStage) return false;
    if (input.userImpact === 'blocking') return true;
    if (input.priority === 'p1') return true;
    return false;
  }

  function admitInput(input: LogSnapshotCaptureInput, trackOccurrence = true): ErrorSnapshotInput | null {
    if (!hasAdmission(input) || !input.operationKind || !input.failureStage) return null;

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

    const priority: SnapshotPriority = input.userImpact === 'blocking' ? 'p0' : (input.priority ?? 'p1');
    const userImpact: SnapshotUserImpact = input.userImpact === 'blocking' ? 'blocking' : 'non-blocking';
    return {
      ...input,
      priority,
      userImpact,
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
      if (!hasAdmission(input)) return;
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
      if (!hasAdmission(input)) return null;
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

/** Extract plain text from an assistant message content field (string or OpenClaw content blocks). */
function extractAssistantMessageText(content: unknown): string | null {
  if (typeof content === 'string') return content.trim() || null;
  if (!Array.isArray(content)) return null;
  let text = '';
  for (const part of content) {
    if (part && typeof part === 'object') {
      const record = part as Record<string, unknown>;
      if (record.type === 'text' && typeof record.text === 'string') {
        text += record.text;
      }
    }
  }
  return text.trim() || null;
}

/**
 * Runtime soft-failure notices are delivered as assistant message content on
 * the `final` stream rather than as a `lifecycle/error` phase. Mirror the
 * renderer `isEmbeddedAgentFailureNoticeAssistantMessage` rules and extend to
 * the "couldn't generate a response" notice so Main can capture them too.
 */
export function isRuntimeSoftFailureNotice(content: unknown): boolean {
  const text = extractAssistantMessageText(content);
  if (!text) return false;
  const normalized = text.toLowerCase();
  if (/^\s*⚠️?\s*agent failed before reply:/i.test(text)) return true;
  if (/^\s*all models failed\s*\(/i.test(text)) return true;
  if (normalized.includes('generate a response')) return true;
  return false;
}

/** Whether a tool-result message signals a tool execution failure (P1, forwarded but non-blocking). */
export function isToolFailureMessage(message: unknown): boolean {
  const record = asRecord(message);
  if (!record) return false;
  const role = typeof record.role === 'string' ? record.role.toLowerCase() : '';
  if (role !== 'tool' && role !== 'function') return false;
  if (record.isError === true || record.is_error === true) return true;
  const content = record.content;
  const text = extractAssistantMessageText(content);
  if (!text) return false;
  const lower = text.toLowerCase();
  return lower.endsWith('failed') || lower.includes('failed:');
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
  const runId = stringValue(params?.runId ?? data?.runId);
  const sessionKey = stringValue(params?.sessionKey ?? data?.sessionKey);

  if (stream === 'lifecycle' && phase === 'error') {
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
    return;
  }

  // Runtime soft-failure notices (e.g. "Agent failed before reply:", "All
  // models failed", "Agent couldn't generate a response") arrive on the
  // `final` stream as assistant message content, not as a lifecycle/error
  // phase. Capture them as the same chat.run_error P0 so the shared
  // fingerprint dedupes against any lifecycle/error snapshot for this run.
  if (stream === 'final') {
    const messagePayload = asRecord(data?.message ?? params?.message);
    const content = messagePayload?.content;
    if (!isRuntimeSoftFailureNotice(content)) {
      // Not a soft-failure notice; fall through to tool-failure handling below.
    } else {

    pipeline.recordEvent({
      eventName: 'gateway.agent_final',
      component: 'gateway',
      source: 'chat',
      runId,
      sessionId: sessionKey,
      status: 'failed',
      metadata: {
        stream,
      },
    });

    if (!runId || !options.isTrackedUserRun?.({ runId, sessionKey })) return;

    const noticeMessage = extractAssistantMessageText(content) ?? 'Agent failed to generate a response';

    await pipeline.captureSnapshot({
      userImpact: 'blocking',
      operationKind: 'user_chat',
      failureStage: 'agent_message_failure',
      level: 'error',
      source: 'chat',
      eventName: 'chat.run_error',
      component: 'gateway-agent',
      errorCode: 'CHAT_RUN_ERROR',
      message: noticeMessage,
      runId,
      sessionKey,
      status: 'failed',
      metadata: {
        stream,
      },
    });
    return;
    }
  }

  // Tool execution failures (Write/Apply Patch/Exec/Canvas/Dir List failed,
  // tool result isError=true) arrive as tool-role messages on the item or
  // final stream. They are P1: forwarded to ELK but non-blocking, scheduled
  // in batches, and never preempt P0.
  if (stream === 'item' || stream === 'final') {
    const messagePayload = asRecord(data?.message ?? params?.message);
    if (!isToolFailureMessage(messagePayload)) return;

    pipeline.recordEvent({
      eventName: 'gateway.tool_failure',
      component: 'gateway',
      source: 'chat',
      runId,
      sessionId: sessionKey,
      status: 'failed',
      metadata: {
        stream,
      },
    });

    if (!runId || !options.isTrackedUserRun?.({ runId, sessionKey })) return;

    const toolMessage = extractAssistantMessageText((messagePayload as Record<string, unknown>)?.content)
      ?? 'Tool execution failed';

    await pipeline.captureSnapshot({
      priority: 'p1',
      userImpact: 'non-blocking',
      operationKind: 'app_runtime',
      failureStage: 'tool_execution',
      level: 'warn',
      source: 'chat',
      eventName: 'chat.tool_failure',
      component: 'gateway-tool',
      errorCode: 'TOOL_EXECUTION_FAILED',
      message: toolMessage,
      runId,
      sessionKey,
      status: 'failed',
      metadata: {
        stream,
      },
    });
  }
}
