import {
  findConcludingAssistantForActiveTurn,
  findTerminalAssistantForActiveTurn,
  shouldKeepRunActiveAfterAssistantFinal,
} from './run-lifecycle';
import type { RawMessage } from './types';
import {
  collectChildDelegationBindings,
  collectCompletedSubagentSessionKeys,
  isWaitingOnSubagentDelegation,
} from '@/lib/subagent-delegation';
import { hasActiveChildDelegations } from '@/lib/subagent-delegation-watch';

export type SessionBackendActivity = {
  sessionKey: string;
  status: string | null;
  processing: boolean;
  hasTrackedUserRun: boolean;
  activeRunIds: string[];
};

export type GatewayBackgroundActivity = {
  hasBackgroundProcessing: boolean;
  processingSessionKeys: string[];
};

const ACTIVE_SESSION_STATUSES = new Set(['running', 'processing', 'queued', 'pending']);

export function isActiveSessionStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  return ACTIVE_SESSION_STATUSES.has(status.toLowerCase());
}

export function isBackendSessionActive(
  activity: SessionBackendActivity | null | undefined,
): boolean {
  if (!activity) return false;
  return activity.processing || activity.hasTrackedUserRun;
}

/** Ignore backend activity snapshots that belong to a different session. */
export function backendActivityForSession(
  activity: SessionBackendActivity | null | undefined,
  sessionKey: string,
): SessionBackendActivity | null {
  if (!activity || activity.sessionKey !== sessionKey) return null;
  return activity;
}

export type UserTurnUiSignals = {
  sending: boolean;
  activeRunId: string | null;
  pendingFinal: boolean;
  aborting?: boolean;
};

export type UserTurnActiveRunOptions = {
  /** Parent session spawned a subagent that has not completed yet. */
  waitingOnSubagentDelegation?: boolean;
};

export function hasLocalRunSignals(state: UserTurnUiSignals): boolean {
  return state.sending || state.pendingFinal || Boolean(state.activeRunId);
}

/** True while the user's current turn should be treated as still in progress. */
export function isUserTurnOpen(
  state: UserTurnUiSignals,
  backendActivity?: SessionBackendActivity | null,
): boolean {
  if (state.aborting) return true;
  if (hasLocalRunSignals(state)) return true;
  return isBackendSessionActive(backendActivity);
}

/** Unified executing signal for Sidebar, stop button, and execution graph. */
export function deriveIsExecuting(
  state: UserTurnUiSignals,
  backendActivity?: SessionBackendActivity | null,
  options?: UserTurnActiveRunOptions,
): boolean {
  if (options?.waitingOnSubagentDelegation) return true;
  return isUserTurnOpen(state, backendActivity);
}

export function deriveHasActiveRunSignal(
  state: UserTurnUiSignals,
  backendActivity?: SessionBackendActivity | null,
  options?: UserTurnActiveRunOptions,
): boolean {
  if (options?.waitingOnSubagentDelegation) return true;
  return isUserTurnOpen(state, backendActivity);
}

/**
 * Finalize only when the transcript has a terminal assistant for the active turn
 * and the backend confirms the session is no longer processing.
 */
export function shouldFinalizeUserTurn(
  messages: RawMessage[],
  lastUserMessageAt: number | null,
  backendActivity: SessionBackendActivity | null | undefined,
  terminalMessage?: RawMessage,
  gatewayBackground?: GatewayBackgroundActivity | null,
): boolean {
  if (isWaitingOnSubagentDelegation(messages, gatewayBackground?.processingSessionKeys ?? [])) {
    return false;
  }
  const completedChildKeys = collectCompletedSubagentSessionKeys(messages);
  const childBindings = collectChildDelegationBindings(messages, completedChildKeys);
  if (hasActiveChildDelegations(childBindings, gatewayBackground?.processingSessionKeys ?? [])) {
    return false;
  }
  const strictTerminal = terminalMessage
    ?? findTerminalAssistantForActiveTurn(messages, lastUserMessageAt);
  if (strictTerminal) {
    if (shouldKeepRunActiveAfterAssistantFinal(strictTerminal)) return false;
    return !isBackendSessionActive(backendActivity);
  }
  const concluding = findConcludingAssistantForActiveTurn(messages, lastUserMessageAt);
  if (!concluding) return false;
  return !isBackendSessionActive(backendActivity);
}

/** Whether a stuck-run timeout should abort and clear UI state. */
export function shouldForceAbortStuckRun(
  backendActivity: SessionBackendActivity | null | undefined,
): boolean {
  return !isBackendSessionActive(backendActivity);
}

export function buildReAdoptRunPatch(
  state: UserTurnUiSignals & { currentSessionKey?: string; runAborted?: boolean },
  sessionKey: string,
  backendActivity: SessionBackendActivity | null | undefined,
): Partial<UserTurnUiSignals & { activeRunId: string | null; pendingFinal: boolean; sending: boolean }> | null {
  if (state.runAborted) {
    return null;
  }
  if (state.currentSessionKey != null && state.currentSessionKey !== sessionKey) {
    return null;
  }
  if (!isBackendSessionActive(backendActivity)) {
    return null;
  }
  if (hasLocalRunSignals(state)) {
    return null;
  }
  const runId = backendActivity?.activeRunIds[0] ?? null;
  return {
    sending: true,
    pendingFinal: true,
    activeRunId: runId,
  };
}
