import { clearErrorRecoveryTimer, clearHistoryPoll, hasVisibleAssistantContent } from './helpers';
import {
  buildClearedActiveRunPatch,
  hasVisibleAssistantReplyForActiveTurn,
  isVisibleAssistantTextWithoutToolUse,
  shouldKeepRunActiveAfterAssistantFinal,
  shouldSilentlyFinalizeRunOnAssistantFinal,
} from './run-lifecycle';
import type { ChatGet, ChatSet } from './store-api';
import {
  ensureSessionBackendPolling,
  refreshSessionBackendActivity,
} from './session-backend-bridge';
import {
  buildKeepUserTurnOpenPatch,
  canClearUserTurnNow,
  canForceClearOnVisibleCommittedReply,
  DELEGATION_FINALIZE_GRACE_MS,
  hasOpenBackendWorkForUserTurn,
  hasOpenDelegatedBackendWork,
  isBackendStronglyActive,
  isTranscriptOnlyDelegationDefer,
} from './user-turn-lifecycle';
import type { RawMessage, SessionStreamingState } from './types';
import {
  findConcludingAssistantForActiveTurn,
  findTerminalAssistantForActiveTurn,
  transcriptHasCommittedConcludingReply,
} from './run-lifecycle';
import {
  collectChildDelegationBindings,
  collectCompletedSubagentSessionKeys,
  isGatewayIdleForSpawnedChildren,
  isInterimSubagentWaitAssistantReply,
  isSubagentDelegationAnnounceRun,
  isVisibleWrapUpAssistantReply,
  parseChildSessionKeyFromAnnounceRun,
  pruneSettledChildProcessingKeys,
  resolveCompletedChildSessionKeys,
} from '@/lib/subagent-delegation';
import { hasDelegationSpawnForActiveTurn, isDelegationWrapUpComplete } from '@/lib/delegation-turn-state';
import {
  summarizeAssistantMessage,
  summarizeBackendActivity,
  summarizeGatewayBackground,
  summarizeTranscriptTail,
  summarizeUiSignals,
  traceTurnTransition,
} from './turn-state-trace';

let _finalizeGraceTimer: ReturnType<typeof setTimeout> | null = null;
let _finalizeGraceSessionKey: string | null = null;
let _finalizeGraceStartedAt: number | null = null;

export function clearFinalizeGraceTimer(): void {
  if (_finalizeGraceTimer) {
    clearTimeout(_finalizeGraceTimer);
    _finalizeGraceTimer = null;
  }
  _finalizeGraceSessionKey = null;
  _finalizeGraceStartedAt = null;
}

export function getFinalizeGraceStartedAt(sessionKey: string): number | null {
  return _finalizeGraceSessionKey === sessionKey ? _finalizeGraceStartedAt : null;
}

function traceFinalizeOutcome(
  outcome: string,
  context: { sessionKey: string; runId?: string; terminalMessage?: RawMessage },
  state: ReturnType<ChatGet>,
  snapshot?: { session: import('./user-turn-lifecycle').SessionBackendActivity; background: import('./user-turn-lifecycle').GatewayBackgroundActivity },
): void {
  traceTurnTransition('finalize-turn', {
    outcome,
    sessionKey: context.sessionKey,
    runId: context.runId ?? null,
    terminal: summarizeAssistantMessage(context.terminalMessage),
    ui: summarizeUiSignals(state),
    backend: summarizeBackendActivity(snapshot?.session ?? state.sessionBackendActivity),
    gateway: summarizeGatewayBackground(snapshot?.background ?? state.gatewayBackgroundActivity),
    transcript: summarizeTranscriptTail(state.messages, state.lastUserMessageAt),
  });
}

function buildCanClearInput(
  state: ReturnType<ChatGet>,
  context: {
    sessionKey: string;
    terminalMessage?: RawMessage;
  },
  snapshot?: {
    session: import('./user-turn-lifecycle').SessionBackendActivity;
    background: import('./user-turn-lifecycle').GatewayBackgroundActivity;
  },
) {
  const completedChildSessionKeys = resolveCompletedChildSessionKeys(
    state.messages,
    state.announcedChildSessionKeys,
  );
  return {
    messages: state.messages,
    lastUserMessageAt: state.lastUserMessageAt,
    backendActivity: snapshot?.session ?? state.sessionBackendActivity,
    terminalMessage: context.terminalMessage,
    gatewayBackground: snapshot?.background ?? state.gatewayBackgroundActivity,
    finalizeGraceStartedAt: getFinalizeGraceStartedAt(context.sessionKey),
    completedChildSessionKeys,
  };
}

function scheduleFinalizeGraceTimer(
  sessionKey: string,
  set: ChatSet,
  get: ChatGet,
  context: { sessionKey: string; runId?: string; terminalMessage?: RawMessage },
): void {
  if (_finalizeGraceSessionKey !== sessionKey) {
    _finalizeGraceStartedAt = Date.now();
    _finalizeGraceSessionKey = sessionKey;
  } else if (_finalizeGraceStartedAt == null) {
    _finalizeGraceStartedAt = Date.now();
  }

  if (_finalizeGraceTimer) return;

  const remaining = Math.max(
    0,
    DELEGATION_FINALIZE_GRACE_MS - (Date.now() - (_finalizeGraceStartedAt ?? Date.now())),
  );
  _finalizeGraceTimer = setTimeout(() => {
    _finalizeGraceTimer = null;
    void runGraceFinalize(get, set, sessionKey, context);
  }, remaining);
}

export function scheduleDelegationFinalizeGraceIfNeeded(
  get: ChatGet,
  set: ChatSet,
  sessionKey: string,
  context: { runId?: string; terminalMessage?: RawMessage } = {},
): void {
  const state = get();
  if (state.currentSessionKey !== sessionKey) return;
  if (state.runAborted) return;
  if (!state.sending && !state.pendingFinal && !state.activeRunId) return;

  if (hasOpenBackendWorkForUserTurn(
    state.gatewayBackgroundActivity,
    state.sessionBackendActivity,
    state.messages,
  )) {
    clearFinalizeGraceTimer();
    return;
  }

  if (!isTranscriptOnlyDelegationDefer(
    state.messages,
    state.gatewayBackgroundActivity,
    state.sessionBackendActivity,
    state.lastUserMessageAt,
  )) {
    return;
  }

  scheduleFinalizeGraceTimer(sessionKey, set, get, { sessionKey, ...context });
}

async function runGraceFinalize(
  get: ChatGet,
  set: ChatSet,
  sessionKey: string,
  context: { runId?: string; terminalMessage?: RawMessage },
): Promise<void> {
  const state = get();
  if (state.currentSessionKey !== sessionKey) return;
  if (state.runAborted) return;
  if (!state.sending && !state.pendingFinal && !state.activeRunId) return;

  const snapshot = await refreshSessionBackendActivity(sessionKey);
  if (get().currentSessionKey !== sessionKey) return;
  if (get().runAborted) return;

  if (snapshot) {
    applyBackendSnapshot(set, snapshot);
  }

  const next = get();
  const processingKeysForWrapUp = snapshot?.background?.processingSessionKeys
    ?? next.gatewayBackgroundActivity?.processingSessionKeys
    ?? [];
  if (isDelegationWrapUpComplete(next.messages, processingKeysForWrapUp, {
    lastUserMessageAt: next.lastUserMessageAt,
    completedChildSessionKeys: new Set([
      ...collectCompletedSubagentSessionKeys(next.messages),
      ...next.announcedChildSessionKeys,
    ]),
  })) {
    console.warn('[chat.finalize-grace] forcing idle after delegation wrap-up complete', {
      sessionKey,
    });
    clearFinalizeGraceTimer();
    clearHistoryPoll();
    clearErrorRecoveryTimer();
    applySettledActiveRunPatch(set, get);
    ensureSessionBackendPolling(sessionKey, set, get);
    return;
  }

  if (hasOpenBackendWorkForUserTurn(
    snapshot?.background ?? next.gatewayBackgroundActivity,
    snapshot?.session ?? next.sessionBackendActivity,
    next.messages,
  )) {
    clearFinalizeGraceTimer();
    applyKeepUserTurnOpen(set, get, { sessionKey, ...context }, snapshot ?? undefined);
    return;
  }

  const graceStartedAt = getFinalizeGraceStartedAt(sessionKey);
  if (canClearUserTurnNow({
    ...buildCanClearInput(next, { sessionKey, ...context }, snapshot ?? undefined),
    finalizeGraceStartedAt: graceStartedAt,
    nowMs: Date.now(),
  })) {
    console.warn('[chat.finalize-grace] forcing idle after delegation grace', {
      sessionKey,
      graceMs: graceStartedAt != null ? Date.now() - graceStartedAt : 0,
    });
    clearFinalizeGraceTimer();
    clearHistoryPoll();
    clearErrorRecoveryTimer();
    applySettledActiveRunPatch(set, get);
    ensureSessionBackendPolling(sessionKey, set, get);
    return;
  }

  if (isTranscriptOnlyDelegationDefer(
    next.messages,
    snapshot?.background ?? next.gatewayBackgroundActivity,
    snapshot?.session ?? next.sessionBackendActivity,
    next.lastUserMessageAt,
  )) {
    scheduleFinalizeGraceTimer(sessionKey, set, get, { sessionKey, ...context });
  }
}

export function buildSettledActiveRunPatch(state: {
  messages: RawMessage[];
  gatewayBackgroundActivity: import('./types').ChatState['gatewayBackgroundActivity'];
  announcedChildSessionKeys: readonly string[];
  lastUserMessageAt?: number | null;
  currentSessionKey?: string;
}): Partial<import('./types').ChatState> {
  const completedChildSessionKeys = resolveCompletedChildSessionKeys(
    state.messages,
    state.announcedChildSessionKeys,
  );
  const processingKeys = state.gatewayBackgroundActivity?.processingSessionKeys ?? [];
  const delegationSpawned = hasDelegationSpawnForActiveTurn(state.messages, {
    lastUserMessageAt: state.lastUserMessageAt,
  });
  const delegationFullySettled = isDelegationWrapUpComplete(state.messages, processingKeys, {
    lastUserMessageAt: state.lastUserMessageAt,
    completedChildSessionKeys,
  });
  let prunedProcessingKeys = delegationSpawned && !delegationFullySettled
    ? [...processingKeys]
    : pruneSettledChildProcessingKeys(
      state.messages,
      processingKeys,
      [...completedChildSessionKeys],
    );
  const parentSessionKey = state.currentSessionKey;
  if (
    parentSessionKey
    && prunedProcessingKeys.includes(parentSessionKey)
    && transcriptHasCommittedConcludingReply(state.messages, state.lastUserMessageAt ?? null)
  ) {
    prunedProcessingKeys = prunedProcessingKeys.filter((key) => key !== parentSessionKey);
  }
  const gatewayBackground = state.gatewayBackgroundActivity
    ? {
      ...state.gatewayBackgroundActivity,
      processingSessionKeys: prunedProcessingKeys,
      hasBackgroundProcessing: prunedProcessingKeys.length > 0,
    }
    : state.gatewayBackgroundActivity;

  return {
    ...buildClearedActiveRunPatch(),
    gatewayBackgroundActivity: gatewayBackground,
  };
}

function emptySessionStreamingSnapshot(lastUserMessageAt: number | null): SessionStreamingState {
  return {
    activeRunId: null,
    activeTool: null,
    streamingText: '',
    streamingMessage: null,
    streamingTools: [],
    pendingFinal: false,
    lastUserMessageAt,
    pendingToolImages: [],
    runAborted: false,
    runError: null,
    sending: false,
    messagesSnapshot: [],
  };
}

function applySettledActiveRunPatch(set: ChatSet, get: ChatGet): void {
  const state = get();
  const sessionKey = state.currentSessionKey;
  const settled = buildSettledActiveRunPatch({
    ...state,
    currentSessionKey: sessionKey,
  });
  const cleared = buildClearedActiveRunPatch();
  const prevSnapshot = state.sessionStreamingStates[sessionKey]
    ?? emptySessionStreamingSnapshot(state.lastUserMessageAt);
  const messagesSnapshot = state.messages.length > 0
    ? [...state.messages]
    : (prevSnapshot.messagesSnapshot.length > 0 ? prevSnapshot.messagesSnapshot : []);

  set({
    ...settled,
    sessionStreamingStates: {
      ...state.sessionStreamingStates,
      [sessionKey]: {
        ...prevSnapshot,
        ...cleared,
        messagesSnapshot,
      },
    },
  });
}

function applyBackendSnapshot(
  set: ChatSet,
  snapshot: { session: import('./user-turn-lifecycle').SessionBackendActivity; background: import('./user-turn-lifecycle').GatewayBackgroundActivity },
): void {
  set({
    sessionBackendActivity: snapshot.session,
    gatewayBackgroundActivity: snapshot.background,
  });
}

function applyKeepUserTurnOpen(
  set: ChatSet,
  get: ChatGet,
  context: { sessionKey: string; runId?: string },
  snapshot?: Awaited<ReturnType<typeof refreshSessionBackendActivity>>,
): void {
  const state = get();
  if (state.currentSessionKey !== context.sessionKey) return;
  if (state.runAborted) return;

  if (snapshot) {
    applyBackendSnapshot(set, snapshot);
  }

  const next = get();
  const processingKeys = snapshot?.background.processingSessionKeys
    ?? next.gatewayBackgroundActivity?.processingSessionKeys
    ?? [];
  if (isDelegationWrapUpComplete(next.messages, processingKeys, {
    lastUserMessageAt: next.lastUserMessageAt,
    completedChildSessionKeys: new Set([
      ...collectCompletedSubagentSessionKeys(next.messages),
      ...next.announcedChildSessionKeys,
    ]),
  })) {
    clearFinalizeGraceTimer();
    clearHistoryPoll();
    clearErrorRecoveryTimer();
    applySettledActiveRunPatch(set, get);
    ensureSessionBackendPolling(context.sessionKey, set, get);
    return;
  }

  const backendActive = isBackendStronglyActive(snapshot?.session ?? next.sessionBackendActivity);
  const sessionStillTracked = processingKeys.includes(context.sessionKey);

  set({
    streamingText: '',
    streamingMessage: null,
    ...buildKeepUserTurnOpenPatch(
      next.activeRunId ?? context.runId ?? snapshot?.session.activeRunIds[0] ?? null,
    ),
    sending: next.sending || backendActive || sessionStillTracked || hasOpenDelegatedBackendWork(
      next.messages,
      snapshot?.background ?? next.gatewayBackgroundActivity,
      snapshot?.session ?? next.sessionBackendActivity,
      { lastUserMessageAt: next.lastUserMessageAt },
    ),
  });
  if (hasOpenBackendWorkForUserTurn(
    snapshot?.background ?? next.gatewayBackgroundActivity,
    snapshot?.session ?? next.sessionBackendActivity,
    next.messages,
  )) {
    clearFinalizeGraceTimer();
  } else {
    scheduleDelegationFinalizeGraceIfNeeded(get, set, context.sessionKey, {
      runId: context.runId,
    });
  }
  ensureSessionBackendPolling(context.sessionKey, set, get);
}

type AnnounceSettleInput = {
  runId?: string;
  lastUserMessageAt?: number | null;
  terminalMessage?: RawMessage;
};

function announceRunMatchesSpawnedChild(
  runId: string | undefined,
  messages: RawMessage[],
): boolean {
  if (!runId) return false;
  const childSessionKey = parseChildSessionKeyFromAnnounceRun(runId);
  if (!childSessionKey) return false;
  const completed = collectCompletedSubagentSessionKeys(messages);
  const bindings = collectChildDelegationBindings(messages, completed);
  return bindings.some((binding) => binding.childSessionKey === childSessionKey);
}

function isVisibleAnnounceDelegationAnswer(
  messages: RawMessage[],
  input: AnnounceSettleInput,
): boolean {
  if (!input.runId || !isSubagentDelegationAnnounceRun(input.runId)) return false;
  if (!announceRunMatchesSpawnedChild(input.runId, messages)) return false;
  if (!hasDelegationSpawnForActiveTurn(messages, { lastUserMessageAt: input.lastUserMessageAt })) {
    return false;
  }
  const terminal = input.terminalMessage;
  if (!terminal || !hasVisibleAssistantContent(terminal)) return false;
  if (isInterimSubagentWaitAssistantReply(terminal)) return false;
  return isVisibleWrapUpAssistantReply(terminal, messages);
}

function hasSettledDelegationAnswer(
  messages: RawMessage[],
  processingSessionKeys: readonly string[],
  input: AnnounceSettleInput,
  completedChildSessionKeys?: ReadonlySet<string>,
): boolean {
  if (isDelegationWrapUpComplete(messages, processingSessionKeys, {
    lastUserMessageAt: input.lastUserMessageAt,
    completedChildSessionKeys,
  })) {
    return true;
  }

  if (isVisibleAnnounceDelegationAnswer(messages, input)) {
    return true;
  }

  if (!input.terminalMessage || !shouldSilentlyFinalizeRunOnAssistantFinal(input.terminalMessage)) {
    return false;
  }

  if (input.terminalMessage && isVisibleAssistantTextWithoutToolUse(input.terminalMessage)) {
    return true;
  }

  if (!input.terminalMessage || !shouldSilentlyFinalizeRunOnAssistantFinal(input.terminalMessage)) {
    return false;
  }

  return hasVisibleAssistantReplyForActiveTurn(messages, input.lastUserMessageAt ?? null);
}

/**
 * Announce wrap-up may settle only when it belongs to a spawned child, gateway
 * work is idle, and the active turn already has a visible delegation answer.
 */
export function canSyncClearAfterAnnounceWrapUp(
  sessionKey: string,
  messages: RawMessage[],
  processingSessionKeys: readonly string[],
  input: AnnounceSettleInput = {},
): boolean {
  if (!announceRunMatchesSpawnedChild(input.runId, messages)) return false;

  // Visible announce wrap-up is authoritative even when the parent session key is
  // still listed in stale gateway processingSessionKeys lag.
  if (isVisibleAnnounceDelegationAnswer(messages, input)) {
    return true;
  }

  const announceChildKey = input.runId ? parseChildSessionKeyFromAnnounceRun(input.runId) : null;
  const completedChildSessionKeys = new Set([
    ...collectCompletedSubagentSessionKeys(messages),
    ...(announceChildKey ? [announceChildKey] : []),
  ]);

  if (isDelegationWrapUpComplete(messages, processingSessionKeys, {
    lastUserMessageAt: input.lastUserMessageAt,
    completedChildSessionKeys,
  })) {
    return true;
  }

  if (processingSessionKeys.includes(sessionKey)) return false;

  if (!isGatewayIdleForSpawnedChildren(sessionKey, messages, processingSessionKeys, completedChildSessionKeys)) {
    return false;
  }
  return hasSettledDelegationAnswer(messages, processingSessionKeys, input, completedChildSessionKeys);
}

/**
 * Push-path finalize: refresh backend once, then clear only when the unified gate allows.
 * Keeps the parent turn open while subagent delegation is in flight.
 */
export function trySyncClearAnnounceWrapUp(
  get: ChatGet,
  set: ChatSet,
  context: {
    sessionKey: string;
    runId?: string;
    terminalMessage?: RawMessage;
  },
): boolean {
  if (!context.runId || !isSubagentDelegationAnnounceRun(context.runId)) return false;

  const state = get();
  if (state.currentSessionKey !== context.sessionKey) return false;
  if (state.runAborted) return false;

  const processingKeys = state.gatewayBackgroundActivity?.processingSessionKeys ?? [];
  if (!canSyncClearAfterAnnounceWrapUp(context.sessionKey, state.messages, processingKeys, {
    runId: context.runId,
    lastUserMessageAt: state.lastUserMessageAt,
    terminalMessage: context.terminalMessage,
  })) {
    return false;
  }

  clearFinalizeGraceTimer();
  clearHistoryPoll();
  clearErrorRecoveryTimer();
  applySettledActiveRunPatch(set, get);
  return true;
}

/**
 * When the transcript already shows a delegation wrap-up but stale run UI
 * (sending/pendingFinal/activeRunId) persisted, settle synchronously.
 */
export function reconcileUserTurnAfterDelegationWrapUp(
  get: ChatGet,
  set: ChatSet,
  sessionKey: string,
): boolean {
  const state = get();
  if (state.currentSessionKey !== sessionKey) return false;
  if (state.runAborted) return false;

  const completedChildSessionKeys = resolveCompletedChildSessionKeys(
    state.messages,
    state.announcedChildSessionKeys,
  );
  const processingKeys = state.gatewayBackgroundActivity?.processingSessionKeys ?? [];
  if (!isDelegationWrapUpComplete(state.messages, processingKeys, {
    lastUserMessageAt: state.lastUserMessageAt,
    completedChildSessionKeys,
  })) {
    return false;
  }

  const terminal = state.messages.length > 0
    ? (findTerminalAssistantForActiveTurn(state.messages, state.lastUserMessageAt)
      ?? findConcludingAssistantForActiveTurn(state.messages, state.lastUserMessageAt))
    : undefined;
  if (!terminal) return false;

  const snapshot = state.sessionStreamingStates[sessionKey];
  const hasStaleRunUi = state.sending || state.pendingFinal || state.activeRunId;
  const hasStaleSnapshot = Boolean(
    snapshot?.sending || snapshot?.pendingFinal || snapshot?.activeRunId,
  );
  const settledPatch = buildSettledActiveRunPatch({
    messages: state.messages,
    gatewayBackgroundActivity: state.gatewayBackgroundActivity,
    announcedChildSessionKeys: state.announcedChildSessionKeys,
    lastUserMessageAt: state.lastUserMessageAt,
    currentSessionKey: sessionKey,
  });
  const currentProcessing = state.gatewayBackgroundActivity?.processingSessionKeys ?? [];
  const prunedProcessing = settledPatch.gatewayBackgroundActivity?.processingSessionKeys ?? [];
  const hasStaleGatewayKeys = prunedProcessing.length !== currentProcessing.length
    || prunedProcessing.some((key, index) => key !== currentProcessing[index]);

  if (!hasStaleRunUi && !hasStaleSnapshot && !hasStaleGatewayKeys) return false;

  if (!canForceClearOnVisibleCommittedReply({
    messages: state.messages,
    lastUserMessageAt: state.lastUserMessageAt,
    backendActivity: state.sessionBackendActivity,
    gatewayBackground: state.gatewayBackgroundActivity,
    terminalMessage: terminal,
    completedChildSessionKeys,
  })) {
    return false;
  }

  clearFinalizeGraceTimer();
  clearHistoryPoll();
  clearErrorRecoveryTimer();
  applySettledActiveRunPatch(set, get);
  return true;
}

function hasAuthoritativeCommittedVisibleFinal(
  state: ReturnType<ChatGet>,
  context: {
    terminalMessage?: RawMessage;
  },
  snapshot: {
    background: import('./user-turn-lifecycle').GatewayBackgroundActivity;
  },
): boolean {
  const terminal = context.terminalMessage;
  if (!isVisibleAssistantTextWithoutToolUse(terminal)) return false;
  if (isInterimSubagentWaitAssistantReply(terminal)) return false;
  if (!transcriptHasCommittedConcludingReply(state.messages, state.lastUserMessageAt)) {
    return false;
  }

  const completedChildSessionKeys = resolveCompletedChildSessionKeys(
    state.messages,
    state.announcedChildSessionKeys,
  );
  if (
    hasDelegationSpawnForActiveTurn(state.messages, { lastUserMessageAt: state.lastUserMessageAt })
    && !isDelegationWrapUpComplete(
      state.messages,
      snapshot.background.processingSessionKeys,
      {
        lastUserMessageAt: state.lastUserMessageAt,
        completedChildSessionKeys,
      },
    )
  ) {
    return false;
  }

  return true;
}

export async function tryFinalizeUserTurnAfterAssistantFinal(
  get: ChatGet,
  set: ChatSet,
  context: {
    sessionKey: string;
    runId?: string;
    terminalMessage?: RawMessage;
  },
): Promise<void> {
  const state = get();
  if (state.currentSessionKey !== context.sessionKey) return;
  if (state.runAborted) return;
  const isAnnounceWrapUpRun = Boolean(context.runId && isSubagentDelegationAnnounceRun(context.runId));
  if (isAnnounceWrapUpRun && trySyncClearAnnounceWrapUp(get, set, context)) {
    traceFinalizeOutcome('announce_sync_cleared', context, state);
    ensureSessionBackendPolling(context.sessionKey, set, get);
    return;
  }
  if (context.runId && state.activeRunId && state.activeRunId !== context.runId && !isAnnounceWrapUpRun) {
    traceFinalizeOutcome('run_id_mismatch', context, state);
    return;
  }

  const snapshot = await refreshSessionBackendActivity(context.sessionKey);
  if (!snapshot) {
    const next = get();
    if (next.currentSessionKey !== context.sessionKey) return;
    if (next.runAborted) return;
    if (isAnnounceWrapUpRun) {
      traceFinalizeOutcome('announce_no_backend_snapshot', context, next);
      ensureSessionBackendPolling(context.sessionKey, set, get);
      return;
    }
    if (hasOpenDelegatedBackendWork(
      next.messages,
      next.gatewayBackgroundActivity,
      next.sessionBackendActivity,
      { lastUserMessageAt: next.lastUserMessageAt },
    )) {
      traceFinalizeOutcome('keep_open_no_snapshot_delegation', context, next);
      applyKeepUserTurnOpen(set, get, context);
      return;
    }
    traceFinalizeOutcome('no_backend_snapshot_poll', context, next);
    ensureSessionBackendPolling(context.sessionKey, set, get);
    return;
  }

  if (get().currentSessionKey !== context.sessionKey) return;
  if (get().runAborted) return;
  if (context.runId && get().activeRunId && get().activeRunId !== context.runId && !isAnnounceWrapUpRun) return;

  applyBackendSnapshot(set, snapshot);

  const next = get();
  const canClearAnnounceWrapUp = isAnnounceWrapUpRun && canSyncClearAfterAnnounceWrapUp(
    context.sessionKey,
    next.messages,
    snapshot.background.processingSessionKeys,
    {
      runId: context.runId,
      lastUserMessageAt: next.lastUserMessageAt,
      terminalMessage: context.terminalMessage,
    },
  );
  const canClearAuthoritativeFinal = !isAnnounceWrapUpRun
    && hasAuthoritativeCommittedVisibleFinal(next, context, snapshot);
  if (
    canClearAnnounceWrapUp
    || canClearAuthoritativeFinal
    || (!isAnnounceWrapUpRun && canClearUserTurnNow(buildCanClearInput(next, context, snapshot)))
  ) {
    clearFinalizeGraceTimer();
    clearHistoryPoll();
    clearErrorRecoveryTimer();
    applySettledActiveRunPatch(set, get);
    traceFinalizeOutcome(
      canClearAnnounceWrapUp
        ? 'announce_cleared'
        : (canClearAuthoritativeFinal ? 'authoritative_visible_final_cleared' : 'cleared'),
      context,
      next,
      snapshot,
    );
    ensureSessionBackendPolling(context.sessionKey, set, get);
    return;
  }

  if (
    isAnnounceWrapUpRun
    && isVisibleAnnounceDelegationAnswer(next.messages, {
      runId: context.runId,
      lastUserMessageAt: next.lastUserMessageAt,
      terminalMessage: context.terminalMessage,
    })
  ) {
    clearFinalizeGraceTimer();
    clearHistoryPoll();
    clearErrorRecoveryTimer();
    applySettledActiveRunPatch(set, get);
    traceFinalizeOutcome('announce_visible_answer_cleared', context, next, snapshot);
    ensureSessionBackendPolling(context.sessionKey, set, get);
    return;
  }

  if (isAnnounceWrapUpRun) {
    traceFinalizeOutcome('announce_wait', context, next, snapshot);
    ensureSessionBackendPolling(context.sessionKey, set, get);
    return;
  }

  traceFinalizeOutcome('keep_open', context, next, snapshot);
  applyKeepUserTurnOpen(set, get, context, snapshot);
}

/**
 * Synchronous check used on silent assistant finals before clearing run state.
 * Returns true when the clear was deferred (caller should break without clearing).
 */
export function deferClearUserTurnForOpenDelegation(
  get: ChatGet,
  set: ChatSet,
  context: {
    sessionKey: string;
    runId?: string;
    messages?: RawMessage[];
    streamingMessage?: unknown | null;
  },
): boolean {
  const state = get();
  if (state.currentSessionKey !== context.sessionKey) return false;
  if (state.runAborted) return false;

  const messages = context.messages ?? state.messages;

  if (!hasOpenDelegatedBackendWork(
    messages,
    state.gatewayBackgroundActivity,
    state.sessionBackendActivity,
    {
      lastUserMessageAt: state.lastUserMessageAt,
      streamingMessage: context.streamingMessage ?? state.streamingMessage,
    },
  )) {
    return false;
  }

  set({
    streamingText: '',
    streamingMessage: null,
    runError: null,
    ...buildKeepUserTurnOpenPatch(state.activeRunId ?? context.runId ?? null),
  });
  void refreshSessionBackendActivity(context.sessionKey).then((snapshot) => {
    if (!snapshot || get().currentSessionKey !== context.sessionKey) return;
    applyBackendSnapshot(set, snapshot);
    applyKeepUserTurnOpen(set, get, context, snapshot);
  });
  ensureSessionBackendPolling(context.sessionKey, set, get);
  scheduleDelegationFinalizeGraceIfNeeded(get, set, context.sessionKey, {
    runId: context.runId,
  });
  return true;
}
