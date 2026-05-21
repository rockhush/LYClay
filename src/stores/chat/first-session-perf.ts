const LABEL = '[perf:first-session]';

type FirstSessionPerfState = {
  sessionKey: string;
  idempotencyKey: string;
  runId: string | null;
  startedAt: number;
  rpcStartedAt: number | null;
  rpcCompletedAt: number | null;
  firstEventAt: number | null;
  firstDeltaAt: number | null;
  completed: boolean;
};

let activeFirstSession: FirstSessionPerfState | null = null;
let firstSessionCompleted = false;

function elapsed(from: number, now = performance.now()): number {
  return Math.round(now - from);
}

function info(event: string, details: Record<string, unknown>): void {
  console.info(LABEL, event, details);
}

export function beginFirstSessionPerf(details: {
  sessionKey: string;
  idempotencyKey: string;
  messageLength: number;
  hasMedia: boolean;
  attachmentCount: number;
}): boolean {
  if (firstSessionCompleted || activeFirstSession) {
    return false;
  }

  const now = performance.now();
  activeFirstSession = {
    sessionKey: details.sessionKey,
    idempotencyKey: details.idempotencyKey,
    runId: null,
    startedAt: now,
    rpcStartedAt: null,
    rpcCompletedAt: null,
    firstEventAt: null,
    firstDeltaAt: null,
    completed: false,
  };

  info('send.started', {
    sessionKey: details.sessionKey,
    idempotencyKey: details.idempotencyKey,
    messageLength: details.messageLength,
    hasMedia: details.hasMedia,
    attachmentCount: details.attachmentCount,
  });
  return true;
}

export function markFirstSessionRpcStarted(method: string): void {
  if (!activeFirstSession) return;
  const now = performance.now();
  activeFirstSession.rpcStartedAt = now;
  info('rpc.started', {
    method,
    sessionKey: activeFirstSession.sessionKey,
    idempotencyKey: activeFirstSession.idempotencyKey,
    sinceSendMs: elapsed(activeFirstSession.startedAt, now),
  });
}

export function markFirstSessionRpcCompleted(details: {
  method: string;
  success: boolean;
  runId?: string | null;
  error?: string;
}): void {
  if (!activeFirstSession) return;
  const now = performance.now();
  activeFirstSession.rpcCompletedAt = now;
  if (details.runId) {
    activeFirstSession.runId = details.runId;
  }
  info('rpc.completed', {
    method: details.method,
    success: details.success,
    runId: details.runId ?? activeFirstSession.runId,
    error: details.error,
    rpcDurationMs: activeFirstSession.rpcStartedAt == null
      ? null
      : elapsed(activeFirstSession.rpcStartedAt, now),
    sinceSendMs: elapsed(activeFirstSession.startedAt, now),
  });

  if (!details.success) {
    activeFirstSession.completed = true;
    firstSessionCompleted = true;
    info('run.completed', {
      state: 'rpc_failed',
      runId: activeFirstSession.runId,
      totalMs: elapsed(activeFirstSession.startedAt, now),
      rpcDurationMs: activeFirstSession.rpcStartedAt == null
        ? null
        : elapsed(activeFirstSession.rpcStartedAt, now),
    });
    activeFirstSession = null;
  }
}

export function markFirstSessionRuntimeEvent(details: {
  state: string;
  runId: string;
  hasMessage: boolean;
}): void {
  if (!activeFirstSession || activeFirstSession.completed) return;
  if (details.runId && !activeFirstSession.runId) {
    activeFirstSession.runId = details.runId;
  }
  if (
    activeFirstSession.runId
    && details.runId
    && activeFirstSession.runId !== details.runId
  ) {
    return;
  }

  const now = performance.now();
  if (!activeFirstSession.firstEventAt) {
    activeFirstSession.firstEventAt = now;
    info('event.first', {
      state: details.state,
      runId: details.runId,
      hasMessage: details.hasMessage,
      sinceSendMs: elapsed(activeFirstSession.startedAt, now),
      sinceRpcCompleteMs: activeFirstSession.rpcCompletedAt == null
        ? null
        : elapsed(activeFirstSession.rpcCompletedAt, now),
    });
  }

  if (details.state === 'delta' && !activeFirstSession.firstDeltaAt) {
    activeFirstSession.firstDeltaAt = now;
    info('delta.first', {
      runId: details.runId,
      sinceSendMs: elapsed(activeFirstSession.startedAt, now),
      sinceFirstEventMs: activeFirstSession.firstEventAt == null
        ? null
        : elapsed(activeFirstSession.firstEventAt, now),
    });
  }

  if (details.state === 'aborted') {
    finishFirstSessionPerf(details.state, details.runId);
  }
}

export function finishFirstSessionPerf(state: string, runId: string): void {
  if (!activeFirstSession || activeFirstSession.completed) return;
  if (
    activeFirstSession.runId
    && runId
    && activeFirstSession.runId !== runId
  ) {
    return;
  }

  const now = performance.now();
  activeFirstSession.completed = true;
  firstSessionCompleted = true;
  info('run.completed', {
    state,
    runId: runId || activeFirstSession.runId,
    totalMs: elapsed(activeFirstSession.startedAt, now),
    timeToFirstEventMs: activeFirstSession.firstEventAt == null
      ? null
      : elapsed(activeFirstSession.startedAt, activeFirstSession.firstEventAt),
    timeToFirstDeltaMs: activeFirstSession.firstDeltaAt == null
      ? null
      : elapsed(activeFirstSession.startedAt, activeFirstSession.firstDeltaAt),
    rpcDurationMs: activeFirstSession.rpcStartedAt == null || activeFirstSession.rpcCompletedAt == null
      ? null
      : elapsed(activeFirstSession.rpcStartedAt, activeFirstSession.rpcCompletedAt),
  });
  activeFirstSession = null;
}
