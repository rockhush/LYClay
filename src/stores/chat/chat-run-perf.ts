import { trackUiEvent } from '@/lib/telemetry';
import type { ReasoningMode } from './types';

const LABEL = '[perf:chat-run-ui]';
const MAX_TRACKED_RUNS = 30;
const MAX_RUN_AGE_MS = 10 * 60 * 1000;

type ChatRunPerfState = {
  localId: string;
  runId: string | null;
  sessionKey: string;
  method: string;
  startedAt: number;
  rpcStartedAt: number | null;
  rpcCompletedAt: number | null;
  firstEventAt: number | null;
  firstDeltaAt: number | null;
  firstTranscriptProgressAt: number | null;
  firstVisibleProgressAt: number | null;
  firstVisibleProgressKind: string | null;
  firstVisibleProgressSource: 'stream' | 'transcript' | null;
  lastTranscriptProgressSignature: string | null;
  completed: boolean;
  selectedReasoningMode: ReasoningMode;
  effectiveReasoningMode: ReasoningMode;
  messageLength: number;
  hasMedia: boolean;
  attachmentCount: number;
  isMainSession: boolean;
  reasoningOverrideReason?: string;
  reasoningOverrideRule?: string;
  reasoningOverrideConfidence?: number;
};

const pendingByLocalId = new Map<string, ChatRunPerfState>();
const activeByRunId = new Map<string, ChatRunPerfState>();

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function elapsed(from: number | null, now = nowMs()): number | null {
  return from == null ? null : Math.round(now - from);
}

function basePayload(state: ChatRunPerfState): Record<string, unknown> {
  return {
    runId: state.runId,
    sessionKey: state.sessionKey,
    method: state.method,
    selectedReasoningMode: state.selectedReasoningMode,
    effectiveReasoningMode: state.effectiveReasoningMode,
    reasoningOverrideReason: state.reasoningOverrideReason,
    reasoningOverrideRule: state.reasoningOverrideRule,
    reasoningOverrideConfidence: state.reasoningOverrideConfidence,
    messageLength: state.messageLength,
    hasMedia: state.hasMedia,
    attachmentCount: state.attachmentCount,
    isMainSession: state.isMainSession,
  };
}

function record(event: string, state: ChatRunPerfState, payload: Record<string, unknown> = {}): void {
  const details = {
    ...basePayload(state),
    ...payload,
  };
  console.info(LABEL, event, details);
  trackUiEvent(`chat.run.${event}`, details);
}

function pruneTrackedRuns(): void {
  const now = nowMs();
  for (const [localId, state] of pendingByLocalId) {
    if (state.completed || now - state.startedAt > MAX_RUN_AGE_MS) {
      pendingByLocalId.delete(localId);
    }
  }
  for (const [runId, state] of activeByRunId) {
    if (state.completed || now - state.startedAt > MAX_RUN_AGE_MS) {
      activeByRunId.delete(runId);
    }
  }
  while (pendingByLocalId.size > MAX_TRACKED_RUNS) {
    const firstKey = pendingByLocalId.keys().next().value;
    if (!firstKey) break;
    pendingByLocalId.delete(firstKey);
  }
  while (activeByRunId.size > MAX_TRACKED_RUNS) {
    const firstKey = activeByRunId.keys().next().value;
    if (!firstKey) break;
    activeByRunId.delete(firstKey);
  }
}

export function beginChatRunPerf(details: {
  localId: string;
  sessionKey: string;
  method: string;
  selectedReasoningMode: ReasoningMode;
  effectiveReasoningMode: ReasoningMode;
  messageLength: number;
  hasMedia: boolean;
  attachmentCount: number;
  isMainSession: boolean;
  reasoningOverrideReason?: string;
  reasoningOverrideRule?: string;
  reasoningOverrideConfidence?: number;
}): void {
  pruneTrackedRuns();
  const state: ChatRunPerfState = {
    localId: details.localId,
    runId: null,
    sessionKey: details.sessionKey,
    method: details.method,
    startedAt: nowMs(),
    rpcStartedAt: null,
    rpcCompletedAt: null,
    firstEventAt: null,
    firstDeltaAt: null,
    firstTranscriptProgressAt: null,
    firstVisibleProgressAt: null,
    firstVisibleProgressKind: null,
    firstVisibleProgressSource: null,
    lastTranscriptProgressSignature: null,
    completed: false,
    selectedReasoningMode: details.selectedReasoningMode,
    effectiveReasoningMode: details.effectiveReasoningMode,
    messageLength: details.messageLength,
    hasMedia: details.hasMedia,
    attachmentCount: details.attachmentCount,
    isMainSession: details.isMainSession,
    reasoningOverrideReason: details.reasoningOverrideReason,
    reasoningOverrideRule: details.reasoningOverrideRule,
    reasoningOverrideConfidence: details.reasoningOverrideConfidence,
  };
  pendingByLocalId.set(details.localId, state);
  record('send.started', state);
}

export function markChatRunRpcStarted(localId: string): void {
  const state = pendingByLocalId.get(localId);
  if (!state || state.completed) return;
  const now = nowMs();
  state.rpcStartedAt = now;
  record('rpc.started', state, {
    sinceSendMs: elapsed(state.startedAt, now),
  });
}

export function markChatRunRpcCompleted(localId: string, details: {
  success: boolean;
  runId?: string | null;
  error?: string;
}): void {
  const state = pendingByLocalId.get(localId);
  if (!state || state.completed) return;
  const now = nowMs();
  state.rpcCompletedAt = now;
  if (details.runId) {
    state.runId = details.runId;
  }
  record('rpc.completed', state, {
    success: details.success,
    error: details.error,
    rpcDurationMs: elapsed(state.rpcStartedAt, now),
    sinceSendMs: elapsed(state.startedAt, now),
  });
  pendingByLocalId.delete(localId);
  if (details.success && details.runId) {
    activeByRunId.set(details.runId, state);
    return;
  }
  state.completed = true;
}

export function markChatRunRuntimeEvent(details: {
  state: string;
  runId: string;
  hasMessage: boolean;
}): void {
  const state = activeByRunId.get(details.runId);
  if (!state || state.completed) return;
  const now = nowMs();
  if (!state.firstEventAt) {
    state.firstEventAt = now;
    record('event.first', state, {
      state: details.state,
      hasMessage: details.hasMessage,
      sinceSendMs: elapsed(state.startedAt, now),
      sinceRpcCompleteMs: elapsed(state.rpcCompletedAt, now),
    });
  }
  if (details.state === 'delta' && !state.firstDeltaAt) {
    state.firstDeltaAt = now;
    record('delta.first', state, {
      sinceSendMs: elapsed(state.startedAt, now),
      sinceRpcCompleteMs: elapsed(state.rpcCompletedAt, now),
      sinceFirstEventMs: elapsed(state.firstEventAt, now),
    });
  }
  if (details.state === 'final' || details.state === 'aborted') {
    finishChatRunPerf(details.state, details.runId);
  }
}

export function markChatRunVisibleProgress(details: {
  runId: string | null;
  source: 'stream' | 'transcript';
  kind: string;
  state?: string;
  messageBlockTypes?: string[];
}): void {
  if (!details.runId) return;
  const state = activeByRunId.get(details.runId);
  if (!state || state.completed || state.firstVisibleProgressAt) return;
  const now = nowMs();
  state.firstVisibleProgressAt = now;
  state.firstVisibleProgressKind = details.kind;
  state.firstVisibleProgressSource = details.source;
  record('visible_progress.first', state, {
    source: details.source,
    kind: details.kind,
    state: details.state,
    messageBlockTypes: details.messageBlockTypes,
    sinceSendMs: elapsed(state.startedAt, now),
    sinceRpcCompleteMs: elapsed(state.rpcCompletedAt, now),
    sinceFirstEventMs: elapsed(state.firstEventAt, now),
    sinceFirstDeltaMs: elapsed(state.firstDeltaAt, now),
  });
}

export function markChatRunTranscriptProgress(details: {
  runId: string | null;
  source: 'local-history' | 'gateway-history';
  messageCount: number;
  assistantCount: number;
  toolResultCount: number;
  latestTimestamp: number | null;
  signature: string;
  visibleKind?: string | null;
  toolUseCount?: number;
  thinkingCount?: number;
  assistantTextCount?: number;
}): void {
  if (!details.runId) return;
  const state = activeByRunId.get(details.runId);
  if (!state || state.completed) return;
  if (state.lastTranscriptProgressSignature === details.signature) return;

  const now = nowMs();
  state.lastTranscriptProgressSignature = details.signature;
  if (!state.firstTranscriptProgressAt) {
    state.firstTranscriptProgressAt = now;
    record('transcript.first_progress', state, {
      source: details.source,
      messageCount: details.messageCount,
      assistantCount: details.assistantCount,
      toolResultCount: details.toolResultCount,
      latestTimestamp: details.latestTimestamp,
      visibleKind: details.visibleKind,
      toolUseCount: details.toolUseCount,
      thinkingCount: details.thinkingCount,
      assistantTextCount: details.assistantTextCount,
      sinceSendMs: elapsed(state.startedAt, now),
      sinceRpcCompleteMs: elapsed(state.rpcCompletedAt, now),
    });
    return;
  }

  record('transcript.progress', state, {
    source: details.source,
    messageCount: details.messageCount,
    assistantCount: details.assistantCount,
    toolResultCount: details.toolResultCount,
    latestTimestamp: details.latestTimestamp,
    visibleKind: details.visibleKind,
    toolUseCount: details.toolUseCount,
    thinkingCount: details.thinkingCount,
    assistantTextCount: details.assistantTextCount,
    sinceSendMs: elapsed(state.startedAt, now),
    sinceRpcCompleteMs: elapsed(state.rpcCompletedAt, now),
    sinceFirstTranscriptProgressMs: elapsed(state.firstTranscriptProgressAt, now),
  });
}

export function finishChatRunPerf(stateName: string, runId: string): void {
  const state = activeByRunId.get(runId);
  if (!state || state.completed) return;
  const now = nowMs();
  state.completed = true;
  record('run.completed', state, {
    state: stateName,
    totalMs: elapsed(state.startedAt, now),
    rpcDurationMs: elapsed(state.rpcStartedAt, state.rpcCompletedAt ?? now),
    timeToFirstEventMs: state.firstEventAt == null ? null : elapsed(state.startedAt, state.firstEventAt),
    timeToFirstDeltaMs: state.firstDeltaAt == null ? null : elapsed(state.startedAt, state.firstDeltaAt),
    timeToFirstTranscriptProgressMs: state.firstTranscriptProgressAt == null
      ? null
      : elapsed(state.startedAt, state.firstTranscriptProgressAt),
    timeToFirstVisibleProgressMs: state.firstVisibleProgressAt == null
      ? null
      : elapsed(state.startedAt, state.firstVisibleProgressAt),
    firstVisibleProgressKind: state.firstVisibleProgressKind,
    firstVisibleProgressSource: state.firstVisibleProgressSource,
  });
  activeByRunId.delete(runId);
}
