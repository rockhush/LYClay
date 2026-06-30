import { clearErrorRecoveryTimer, clearHistoryPoll } from './helpers';
import { buildClearedActiveRunPatch } from './run-lifecycle';
import type { ChatGet, ChatSet } from './store-api';
import {
  ensureSessionBackendPolling,
  refreshSessionBackendActivity,
} from './session-backend-bridge';
import {
  buildKeepUserTurnOpenPatch,
  canClearUserTurnNow,
  DELEGATION_FINALIZE_GRACE_MS,
  hasOpenBackendWorkForUserTurn,
  hasOpenDelegatedBackendWork,
  isBackendStronglyActive,
  isTranscriptOnlyDelegationDefer,
} from './user-turn-lifecycle';
import type { RawMessage } from './types';
import {
  collectChildDelegationBindings,
  collectCompletedSubagentSessionKeys,
  isGatewayIdleForSpawnedChildren,
  isSubagentDelegationAnnounceRun,
} from '@/lib/subagent-delegation';

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
  return {
    messages: state.messages,
    lastUserMessageAt: state.lastUserMessageAt,
    backendActivity: snapshot?.session ?? state.sessionBackendActivity,
    terminalMessage: context.terminalMessage,
    gatewayBackground: snapshot?.background ?? state.gatewayBackgroundActivity,
    finalizeGraceStartedAt: getFinalizeGraceStartedAt(context.sessionKey),
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
    set(buildClearedActiveRunPatch());
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
  const backendActive = isBackendStronglyActive(snapshot?.session ?? next.sessionBackendActivity);
  const processingKeys = snapshot?.background.processingSessionKeys
    ?? next.gatewayBackgroundActivity?.processingSessionKeys
    ?? [];
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

/**
 * Gateway-only check for announce wrap-up: parent + spawned children must be
 * idle. Ignores stale `hasTrackedUserRun` snapshots that lag behind push finals.
 */
export function canSyncClearAfterAnnounceWrapUp(
  sessionKey: string,
  messages: RawMessage[],
  processingSessionKeys: readonly string[],
): boolean {
  return isGatewayIdleForSpawnedChildren(sessionKey, messages, processingSessionKeys);
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
  },
): boolean {
  if (!context.runId || !isSubagentDelegationAnnounceRun(context.runId)) return false;

  const state = get();
  if (state.currentSessionKey !== context.sessionKey) return false;
  if (state.runAborted) return false;

  const processingKeys = state.gatewayBackgroundActivity?.processingSessionKeys ?? [];
  if (!canSyncClearAfterAnnounceWrapUp(context.sessionKey, state.messages, processingKeys)) {
    return false;
  }

  clearFinalizeGraceTimer();
  clearHistoryPoll();
  clearErrorRecoveryTimer();
  set(buildClearedActiveRunPatch());
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
    ensureSessionBackendPolling(context.sessionKey, set, get);
    return;
  }
  if (context.runId && state.activeRunId && state.activeRunId !== context.runId && !isAnnounceWrapUpRun) return;

  const snapshot = await refreshSessionBackendActivity(context.sessionKey);
  if (!snapshot) {
    const next = get();
    if (next.currentSessionKey !== context.sessionKey) return;
    if (next.runAborted) return;
    if (hasOpenDelegatedBackendWork(
      next.messages,
      next.gatewayBackgroundActivity,
      next.sessionBackendActivity,
      { lastUserMessageAt: next.lastUserMessageAt },
    )) {
      applyKeepUserTurnOpen(set, get, context);
      return;
    }
    ensureSessionBackendPolling(context.sessionKey, set, get);
    return;
  }

  if (get().currentSessionKey !== context.sessionKey) return;
  if (get().runAborted) return;
  if (context.runId && get().activeRunId && get().activeRunId !== context.runId && !isAnnounceWrapUpRun) return;

  applyBackendSnapshot(set, snapshot);

  const next = get();
  if (canClearUserTurnNow(buildCanClearInput(next, context, snapshot))
    || (isAnnounceWrapUpRun && !hasOpenBackendWorkForUserTurn(
      snapshot.background,
      snapshot.session,
      next.messages,
    ))) {
    clearFinalizeGraceTimer();
    clearHistoryPoll();
    clearErrorRecoveryTimer();
    set(buildClearedActiveRunPatch());
    ensureSessionBackendPolling(context.sessionKey, set, get);
    return;
  }

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
