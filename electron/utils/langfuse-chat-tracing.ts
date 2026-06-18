import { createTraceId, startObservation } from '@langfuse/tracing';
import { flushLangfuseTracing, isLangfuseTracingEnabled, randomLangfuseSpanId } from '../instrumentation/langfuse';
import { logger } from './logger';

type LangfuseObservation = {
  update: (fields: Record<string, unknown>) => void;
  end: () => void;
};

type ChatSendMeta = {
  sessionKey?: string;
  sessionId?: string;
  idempotencyKey?: string;
  messageLength?: number;
  isWarmup: boolean;
  isCompactor: boolean;
};

type PendingChatTrace = {
  root: LangfuseObservation;
  meta: ChatSendMeta;
  requestId: string;
  method: string;
  startedAt: number;
  milestones: Array<Record<string, unknown>>;
};

type ActiveChatTrace = PendingChatTrace & {
  runId: string;
  rpcAcceptedAt?: number;
  rpcDurationMs?: number;
  firstEventAt?: number;
  firstDeltaAt?: number;
  firstVisibleProgressAt?: number;
  deltaCount: number;
  lastDeltaAt?: number;
};

const pendingByRequestId = new Map<string, PendingChatTrace>();
const activeByRunId = new Map<string, ActiveChatTrace>();
const requestIdByRunId = new Map<string, string>();
const runIdBySessionId = new Map<string, string>();

function extractChatSendMeta(params?: unknown): ChatSendMeta | null {
  if (!params || typeof params !== 'object') {
    return null;
  }
  const record = params as Record<string, unknown>;
  const sessionKey = typeof record.sessionKey === 'string' ? record.sessionKey : undefined;
  const sessionId = typeof record.sessionId === 'string' ? record.sessionId : undefined;
  const idempotencyKey = typeof record.idempotencyKey === 'string' ? record.idempotencyKey : undefined;
  const message = typeof record.message === 'string' ? record.message : '';
  const isWarmup = sessionKey === 'agent:main:__warmup__';
  const isCompactor = sessionKey === 'agent:main:__compactor__';
  return {
    sessionKey,
    sessionId,
    idempotencyKey,
    messageLength: message.length,
    isWarmup,
    isCompactor,
  };
}

function pushMilestone(trace: PendingChatTrace, name: string, fields: Record<string, unknown> = {}): void {
  trace.milestones.push({
    name,
    elapsedMs: Date.now() - trace.startedAt,
    ...fields,
  });
}

function traceName(meta: ChatSendMeta): string {
  if (meta.isCompactor) return 'chat.context-compactor';
  if (meta.isWarmup) return 'chat.warmup';
  return 'chat.send';
}

async function startRootObservation(meta: ChatSendMeta, requestId: string, method: string, timeoutMs: number): Promise<LangfuseObservation> {
  const input = {
    sessionKey: meta.sessionKey,
    sessionId: meta.sessionId,
    idempotencyKey: meta.idempotencyKey,
    messageLength: meta.messageLength,
    method,
    timeoutMs,
  };

  if (meta.idempotencyKey) {
    const traceId = await createTraceId(meta.idempotencyKey);
    return startObservation(
      traceName(meta),
      {
        input,
        metadata: {
          sessionId: meta.sessionKey ?? meta.sessionId,
          tags: [
            meta.isCompactor ? 'context-compactor' : 'user-chat',
            'lyclaw',
          ],
        },
      },
      {
        asType: 'span',
        parentSpanContext: {
          traceId,
          spanId: randomLangfuseSpanId(),
          traceFlags: 1,
        },
      },
    );
  }

  return startObservation(traceName(meta), {
    input,
    metadata: {
      sessionId: meta.sessionKey ?? meta.sessionId,
      tags: [
        meta.isCompactor ? 'context-compactor' : 'user-chat',
        'lyclaw',
      ],
    },
  }, { asType: 'span' });
}

function shouldTraceUserChat(meta: ChatSendMeta): boolean {
  return !meta.isWarmup;
}

export async function beginChatSendTrace(args: {
  requestId: string;
  method: string;
  params?: unknown;
  timeoutMs: number;
}): Promise<void> {
  if (!isLangfuseTracingEnabled() || args.method !== 'chat.send') {
    return;
  }

  const meta = extractChatSendMeta(args.params);
  if (!meta || !shouldTraceUserChat(meta)) {
    return;
  }

  try {
    const root = await startRootObservation(meta, args.requestId, args.method, args.timeoutMs);
    const trace: PendingChatTrace = {
      root,
      meta,
      requestId: args.requestId,
      method: args.method,
      startedAt: Date.now(),
      milestones: [],
    };
    pushMilestone(trace, 'rpc.started');
    pendingByRequestId.set(args.requestId, trace);
  } catch (error) {
    logger.warn('[langfuse] beginChatSendTrace failed:', error);
  }
}

export function finishChatSendRpc(args: {
  requestId: string;
  success: boolean;
  runId?: string;
  durationMs: number;
  error?: string;
}): void {
  const pending = pendingByRequestId.get(args.requestId);
  if (!pending) {
    return;
  }

  try {
    pushMilestone(pending, args.success ? 'rpc.completed' : 'rpc.failed', {
      durationMs: args.durationMs,
      runId: args.runId,
      error: args.error,
    });

    pending.root.update({
      metadata: {
        rpcDurationMs: args.durationMs,
        runId: args.runId,
        success: args.success,
        error: args.error,
        milestones: pending.milestones,
      },
    });

    if (!args.success || !args.runId) {
      pending.root.update({
        output: { status: args.success ? 'accepted_without_run_id' : 'rpc_failed', error: args.error },
      }).end();
      pendingByRequestId.delete(args.requestId);
      return;
    }

    const active: ActiveChatTrace = {
      ...pending,
      runId: args.runId,
      rpcAcceptedAt: Date.now(),
      rpcDurationMs: args.durationMs,
      deltaCount: 0,
    };
    activeByRunId.set(args.runId, active);
    requestIdByRunId.set(args.runId, args.requestId);
    if (pending.meta.sessionId) {
      runIdBySessionId.set(pending.meta.sessionId, args.runId);
    }
    pendingByRequestId.delete(args.requestId);
    pushMilestone(active, 'run.accepted', { runId: args.runId, rpcDurationMs: args.durationMs });
  } catch (error) {
    logger.warn('[langfuse] finishChatSendRpc failed:', error);
  }
}

export function recordChatSendPending(args: {
  requestId: string;
  pendingMs: number;
  watchdogDelayMs: number;
  sessionKey?: string;
}): void {
  const pending = pendingByRequestId.get(args.requestId);
  if (!pending) {
    return;
  }

  try {
    pushMilestone(pending, 'watchdog.chat_send_pending', {
      pendingMs: args.pendingMs,
      watchdogDelayMs: args.watchdogDelayMs,
      sessionKey: args.sessionKey,
    });
    pending.root.update({
      level: args.pendingMs >= 60_000 ? 'WARNING' : 'DEFAULT',
      metadata: {
        pendingMs: args.pendingMs,
        watchdogDelayMs: args.watchdogDelayMs,
        milestones: pending.milestones,
      },
    });
  } catch (error) {
    logger.warn('[langfuse] recordChatSendPending failed:', error);
  }
}

export function recordChatRunPending(args: {
  kind: 'first_event' | 'first_visible_progress';
  runId: string;
  pendingMs: number;
  watchdogDelayMs: number;
  sessionKey?: string;
}): void {
  const active = activeByRunId.get(args.runId);
  if (!active) {
    return;
  }

  try {
    pushMilestone(active, `watchdog.${args.kind}`, {
      pendingMs: args.pendingMs,
      watchdogDelayMs: args.watchdogDelayMs,
      sessionKey: args.sessionKey,
    });
    active.root.update({
      level: args.pendingMs >= 60_000 ? 'WARNING' : 'DEFAULT',
      metadata: {
        [`${args.kind}PendingMs`]: args.pendingMs,
        milestones: active.milestones,
      },
    });
  } catch (error) {
    logger.warn('[langfuse] recordChatRunPending failed:', error);
  }
}

export function recordChatStreamEvent(args: {
  runId: string;
  state: string;
  sessionKey?: string;
  visibleProgressKind?: string;
  messageBlockTypes?: string[];
}): void {
  const active = activeByRunId.get(args.runId);
  if (!active) {
    return;
  }

  const now = Date.now();
  try {
    if (!active.firstEventAt) {
      active.firstEventAt = now;
      pushMilestone(active, 'stream.first_event', { state: args.state });
    }

    if (args.state === 'delta') {
      active.deltaCount += 1;
      active.lastDeltaAt = now;
      if (!active.firstDeltaAt) {
        active.firstDeltaAt = now;
        pushMilestone(active, 'stream.first_delta', {
          sinceAcceptedMs: active.rpcAcceptedAt ? now - active.rpcAcceptedAt : undefined,
        });
      } else if (active.deltaCount % 25 === 0) {
        pushMilestone(active, 'stream.delta.sample', {
          deltaCount: active.deltaCount,
          sinceAcceptedMs: active.rpcAcceptedAt ? now - active.rpcAcceptedAt : undefined,
        });
      }
    }

    if (args.visibleProgressKind && !active.firstVisibleProgressAt) {
      active.firstVisibleProgressAt = now;
      pushMilestone(active, 'stream.first_visible_progress', {
        kind: args.visibleProgressKind,
        blockTypes: args.messageBlockTypes,
      });
    }

    active.root.update({
      metadata: {
        runId: args.runId,
        lastState: args.state,
        deltaCount: active.deltaCount,
        timeToFirstEventMs: active.firstEventAt && active.rpcAcceptedAt
          ? active.firstEventAt - active.rpcAcceptedAt
          : undefined,
        timeToFirstDeltaMs: active.firstDeltaAt && active.rpcAcceptedAt
          ? active.firstDeltaAt - active.rpcAcceptedAt
          : undefined,
        timeToFirstVisibleProgressMs: active.firstVisibleProgressAt && active.rpcAcceptedAt
          ? active.firstVisibleProgressAt - active.rpcAcceptedAt
          : undefined,
        milestones: active.milestones,
      },
    });
  } catch (error) {
    logger.warn('[langfuse] recordChatStreamEvent failed:', error);
  }
}

export function finishChatRunTrace(args: {
  runId: string;
  state: string;
  sessionKey?: string;
  totalSinceRequestedMs?: number;
  totalSinceAcceptedMs?: number;
}): void {
  const active = activeByRunId.get(args.runId);
  if (!active) {
    return;
  }

  try {
    pushMilestone(active, 'run.completed', {
      state: args.state,
      totalSinceRequestedMs: args.totalSinceRequestedMs,
      totalSinceAcceptedMs: args.totalSinceAcceptedMs,
      deltaCount: active.deltaCount,
    });

    const status = args.state === 'error' ? 'ERROR' : args.state === 'aborted' ? 'WARNING' : 'DEFAULT';
    active.root.update({
      level: status,
      output: {
        state: args.state,
        deltaCount: active.deltaCount,
        totalSinceRequestedMs: args.totalSinceRequestedMs,
        totalSinceAcceptedMs: args.totalSinceAcceptedMs,
      },
      metadata: {
        milestones: active.milestones,
      },
    }).end();

    activeByRunId.delete(args.runId);
    const requestId = requestIdByRunId.get(args.runId);
    if (requestId) {
      pendingByRequestId.delete(requestId);
      requestIdByRunId.delete(args.runId);
    }
    if (active.meta.sessionId) {
      runIdBySessionId.delete(active.meta.sessionId);
    }
    void flushLangfuseTracing();
  } catch (error) {
    logger.warn('[langfuse] finishChatRunTrace failed:', error);
  }
}

export function recordGatewayModelUsage(args: {
  sessionId?: string;
  provider?: string;
  model?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  totalTokens?: number;
}): void {
  if (!isLangfuseTracingEnabled() || !args.sessionId) {
    return;
  }

  const runId = runIdBySessionId.get(args.sessionId);
  const active = runId ? activeByRunId.get(runId) : undefined;

  try {
    if (active) {
      pushMilestone(active, 'model.usage', {
        provider: args.provider,
        model: args.model,
        input: args.input,
        output: args.output,
        cacheRead: args.cacheRead,
        totalTokens: args.totalTokens,
      });
      active.root.update({
        metadata: {
          usage: {
            input: args.input,
            output: args.output,
            cacheRead: args.cacheRead,
            totalTokens: args.totalTokens,
            provider: args.provider,
          },
          milestones: active.milestones,
        },
      });
    }

    const generation = startObservation(
      active ? 'model.completion' : 'gateway.model.completion',
      {
        model: args.model ?? args.provider ?? 'unknown',
        input: { sessionId: args.sessionId, provider: args.provider },
        output: {
          inputTokens: args.input,
          outputTokens: args.output,
          cacheReadTokens: args.cacheRead,
          totalTokens: args.totalTokens,
        },
        metadata: {
          provider: args.provider,
          cacheRead: args.cacheRead,
          sessionId: args.sessionId,
          runId: runId ?? null,
        },
      },
      { asType: 'generation' },
    );
    generation.update({
      usageDetails: {
        input: args.input ?? 0,
        output: args.output ?? 0,
        cache_read_input_tokens: args.cacheRead ?? 0,
        total: args.totalTokens ?? 0,
      },
    }).end();

    void flushLangfuseTracing();
  } catch (error) {
    logger.warn('[langfuse] recordGatewayModelUsage failed:', error);
  }
}
