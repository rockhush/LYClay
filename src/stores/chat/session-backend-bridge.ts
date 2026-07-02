import { getSessionBackendActivity } from '@/lib/host-api';
import { useGatewayStore } from '@/stores/gateway';
import { isWaitingOnSubagentDelegation } from '@/lib/subagent-delegation';
import type { ChatState } from './types';
import type { ChatGet, ChatSet } from './store-api';
import {
  buildReAdoptRunPatch,
  backendActivityForSession,
  hasLocalRunSignals,
  hasOpenBackendWorkForUserTurn,
  isBackendStronglyActive,
  type GatewayBackgroundActivity,
  type SessionBackendActivity,
} from './user-turn-lifecycle';
import { isUserAbortedSession } from './user-aborted-sessions';

const RECONCILE_DEBOUNCE_MS = 500;

let _reconcileTimer: ReturnType<typeof setTimeout> | null = null;
let _reconcileSessionKey: string | null = null;

export function clearSessionActivityPoll(): void {
  if (_reconcileTimer) {
    clearTimeout(_reconcileTimer);
    _reconcileTimer = null;
  }
  _reconcileSessionKey = null;
}

function isGatewayRunning(): boolean {
  return useGatewayStore.getState().status.state === 'running';
}

function hasAnyBackgroundSessionActivity(state: ChatState, sessionKey: string): boolean {
  const sessionActivity = backendActivityForSession(state.sessionBackendActivity, sessionKey);
  return hasOpenBackendWorkForUserTurn(
    state.gatewayBackgroundActivity,
    sessionActivity,
    state.messages,
  );
}

function hasAnySavedStreamingActivity(state: ChatState): boolean {
  return Object.values(state.sessionStreamingStates).some((entry) => (
    Boolean(entry?.sending || entry?.activeRunId || entry?.pendingFinal)
  ));
}

/** Whether an on-demand backend reconcile is worthwhile for this session. */
export function shouldScheduleBackendReconcile(state: ChatState, sessionKey: string): boolean {
  if (!isGatewayRunning()) return false;
  if (state.currentSessionKey !== sessionKey) return false;
  if (state.runAborted) return false;
  if (isUserAbortedSession(sessionKey)) return false;

  if (hasLocalRunSignals({
    sending: state.sending,
    activeRunId: state.activeRunId,
    pendingFinal: state.pendingFinal,
  })) {
    return true;
  }

  const sessionActivity = backendActivityForSession(state.sessionBackendActivity, sessionKey);
  if (isBackendStronglyActive(sessionActivity)) return true;
  if (hasAnyBackgroundSessionActivity(state, sessionKey)) return true;
  if (hasAnySavedStreamingActivity(state)) return true;

  if (state.emptyFinalRecovery.status === 'waiting' || state.emptyFinalRecovery.status === 'checking') {
    return true;
  }

  if (isWaitingOnSubagentDelegation(
    state.messages,
    state.gatewayBackgroundActivity?.processingSessionKeys ?? [],
  )) {
    return true;
  }

  return false;
}

/** @deprecated Use shouldScheduleBackendReconcile — kept for existing tests/callers. */
export const shouldContinueBackendPolling = shouldScheduleBackendReconcile;

export async function refreshSessionBackendActivity(
  sessionKey: string,
): Promise<{ session: SessionBackendActivity; background: GatewayBackgroundActivity } | null> {
  try {
    const response = await getSessionBackendActivity(sessionKey);
    if (!response.success) return null;
    return {
      session: response.session,
      background: response.background,
    };
  } catch (error) {
    console.warn('[chat.session-activity] refresh failed', { sessionKey, error: String(error) });
    return null;
  }
}

async function runBackendReconcileOnce(
  sessionKey: string,
  apply: (partial: Partial<ChatState>) => void,
  getState: () => ChatState,
): Promise<void> {
  if (_reconcileSessionKey !== sessionKey) return;

  const state = getState();
  if (state.currentSessionKey !== sessionKey) {
    clearSessionActivityPoll();
    return;
  }

  if (!shouldScheduleBackendReconcile(state, sessionKey)) {
    clearSessionActivityPoll();
    return;
  }

  const snapshot = await refreshSessionBackendActivity(sessionKey);
  if (_reconcileSessionKey !== sessionKey) return;

  const nextState = getState();
  if (nextState.currentSessionKey !== sessionKey) {
    clearSessionActivityPoll();
    return;
  }

  if (snapshot) {
    apply({
      sessionBackendActivity: snapshot.session,
      gatewayBackgroundActivity: snapshot.background,
    });

    const reAdopt = buildReAdoptRunPatch(
      { ...getState(), currentSessionKey: sessionKey },
      sessionKey,
      snapshot.session,
      snapshot.background,
    );
    if (reAdopt) {
      apply(reAdopt);
    }
  }

  clearSessionActivityPoll();
}

/**
 * Debounced one-shot backend reconcile (no 4s loop).
 * Triggered by push events: send, final, phase=completed, session switch.
 */
export function scheduleBackendReconcileOnce(
  sessionKey: string,
  apply: (partial: Partial<ChatState>) => void,
  getState: () => ChatState,
): void {
  if (!isGatewayRunning()) return;
  if (!shouldScheduleBackendReconcile(getState(), sessionKey)) return;
  if (_reconcileSessionKey === sessionKey && _reconcileTimer) return;

  clearSessionActivityPoll();
  _reconcileSessionKey = sessionKey;
  _reconcileTimer = setTimeout(() => {
    void runBackendReconcileOnce(sessionKey, apply, getState);
  }, RECONCILE_DEBOUNCE_MS);
}

/** Debounced one-shot reconcile wired to zustand set/get. */
export function ensureSessionBackendPolling(
  sessionKey: string,
  set: ChatSet,
  get: ChatGet,
): void {
  scheduleBackendReconcileOnce(sessionKey, set, get);
}

/** @deprecated Alias for ensureSessionBackendPolling. */
export const startSessionActivityPoll = ensureSessionBackendPolling;

export function isSessionStillProcessingOnBackend(
  activity: SessionBackendActivity | null | undefined,
): boolean {
  if (!activity) return false;
  return activity.hasTrackedUserRun;
}
