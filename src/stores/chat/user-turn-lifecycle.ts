import { hasVisibleAssistantContent } from './helpers';
import {
  findConcludingAssistantForActiveTurn,
  findTerminalAssistantForActiveTurn,
  isRunTerminalAssistantMessage,
  hasVisibleAssistantReplyForActiveTurn,
  isVisibleAssistantTextWithoutToolUse,
  shouldKeepRunActiveAfterAssistantFinal,
  shouldSilentlyFinalizeRunOnAssistantFinal,
} from './run-lifecycle';
import type { RawMessage, SessionStreamingState } from './types';
import {
  collectChildDelegationBindings,
  collectCompletedSubagentSessionKeys,
} from '@/lib/subagent-delegation';
import { hasDelegationSpawnForActiveTurn, isParentDelegationPhaseOpen, isDelegationWrapUpComplete } from '@/lib/delegation-turn-state';
import { isGatewayIdleForSpawnedChildren } from '@/lib/subagent-delegation';
import { hasGatewayActiveChildDelegations } from '@/lib/subagent-delegation-watch';
import { clearUserAbortedSession, isUserAbortedSession } from './user-aborted-sessions';

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

/** Gateway memory metrics 锟?authoritative for finalize / re-adopt. */
export function isBackendStronglyActive(
  activity: SessionBackendActivity | null | undefined,
): boolean {
  if (!activity) return false;
  return activity.hasTrackedUserRun;
}

/** Includes disk/exec weak signals 锟?display/reconcile hint only, not finalize blocking. */
export function isBackendSessionActive(
  activity: SessionBackendActivity | null | undefined,
): boolean {
  if (!activity) return false;
  return activity.processing || activity.hasTrackedUserRun;
}

/** Gateway work relevant to this session (not other sessions' background runs). */
export function hasOpenBackendWorkForUserTurn(
  gatewayBackground: GatewayBackgroundActivity | null | undefined,
  backendActivity: SessionBackendActivity | null | undefined,
  messages: RawMessage[] = [],
): boolean {
  if (isBackendStronglyActive(backendActivity)) return true;

  const processingKeys = gatewayBackground?.processingSessionKeys ?? [];

  if (messages.length > 0 && processingKeys.length > 0) {
    const completedChildKeys = collectCompletedSubagentSessionKeys(messages);
    const childBindings = collectChildDelegationBindings(messages, completedChildKeys);
    // Gateway-only: a child is open backend work only while the gateway still
    // lists it. A missing/late transcript completion marker must not block the
    // parent turn from finalizing (otherwise it stays stuck in "thinking").
    if (hasGatewayActiveChildDelegations(childBindings, processingKeys)) return true;
  }

  return false;
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
  runAborted?: boolean;
};

export type UserTurnActiveRunOptions = {
  /** Transcript + gateway observe an in-flight child session. */
  waitingOnSubagentDelegation?: boolean;
  gatewayBackground?: GatewayBackgroundActivity | null;
  messages?: RawMessage[];
  lastUserMessageAt?: number | null;
  streamingMessage?: unknown | null;
  /** When set, a persisted user-abort marker suppresses executing UI until backend idle. */
  sessionKey?: string;
};

export function hasLocalRunSignals(state: UserTurnUiSignals): boolean {
  return state.sending || state.pendingFinal || Boolean(state.activeRunId);
}

/** True while the user's current turn should be treated as still in progress. */
export function isUserTurnOpen(
  state: UserTurnUiSignals,
  backendActivity?: SessionBackendActivity | null,
  gatewayBackground?: GatewayBackgroundActivity | null,
  messages: RawMessage[] = [],
): boolean {
  if (state.runAborted) return false;
  if (state.aborting) return true;
  if (hasLocalRunSignals(state)) return true;
  if (hasOpenBackendWorkForUserTurn(gatewayBackground, backendActivity, messages)) return true;
  return false;
}

/** Clear persisted user-abort marker once backend work has fully stopped. */
export function releaseUserAbortedSessionWhenIdle(
  sessionKey: string,
  backendActivity: SessionBackendActivity | null | undefined,
  gatewayBackground?: GatewayBackgroundActivity | null,
  messages: RawMessage[] = [],
): boolean {
  if (!isUserAbortedSession(sessionKey)) return false;
  if (hasOpenBackendWorkForUserTurn(gatewayBackground, backendActivity, messages)) {
    return false;
  }
  clearUserAbortedSession(sessionKey);
  return true;
}

/** Unified executing signal for Sidebar, stop button, and execution graph. */
export function deriveIsExecuting(
  state: UserTurnUiSignals,
  backendActivity?: SessionBackendActivity | null,
  options?: UserTurnActiveRunOptions,
): boolean {
  if (options?.sessionKey && isUserAbortedSession(options.sessionKey)) return false;
  if (state.runAborted) return false;
  const messages = options?.messages ?? [];
  const processingKeys = options?.gatewayBackground?.processingSessionKeys ?? [];
  if (messages.length > 0
    && isDelegationWrapUpComplete(messages, processingKeys, {
      lastUserMessageAt: options?.lastUserMessageAt,
    })
    && isGatewayIdleForSpawnedChildren(
      backendActivity?.sessionKey ?? '',
      messages,
      processingKeys,
    )) {
    return false;
  }
  if (options?.waitingOnSubagentDelegation) return true;
  if (messages.length > 0 && isParentDelegationPhaseOpen(messages, processingKeys, {
    lastUserMessageAt: options?.lastUserMessageAt,
    streamingMessage: options?.streamingMessage,
  })) {
    return true;
  }
  if (hasLocalRunSignals(state) && messages.length > 0 && canClearUserTurnNow({
    messages,
    lastUserMessageAt: options?.lastUserMessageAt ?? null,
    backendActivity,
    gatewayBackground: options?.gatewayBackground,
  })) {
    return false;
  }
  if (hasLocalRunSignals(state) && messages.length > 0 && canForceClearOnVisibleCommittedReply({
    messages,
    lastUserMessageAt: options?.lastUserMessageAt ?? null,
    backendActivity,
    gatewayBackground: options?.gatewayBackground,
  })) {
    return false;
  }
  return isUserTurnOpen(
    state,
    backendActivity,
    options?.gatewayBackground,
    messages,
  );
}

export function deriveHasActiveRunSignal(
  state: UserTurnUiSignals,
  backendActivity?: SessionBackendActivity | null,
  options?: UserTurnActiveRunOptions,
): boolean {
  return deriveIsExecuting(state, backendActivity, options);
}

export type DeriveSidebarSessionIsExecutingInput = {
  sessionKey: string;
  isCurrent: boolean;
  currentUi: UserTurnUiSignals;
  currentMessages: RawMessage[];
  currentLastUserMessageAt: number | null;
  currentStreamingMessage: unknown | null;
  waitingOnSubagentDelegation: boolean;
  sessionBackendActivity: SessionBackendActivity | null | undefined;
  gatewayBackground: GatewayBackgroundActivity | null | undefined;
  snapshot?: Pick<
    SessionStreamingState,
    | 'activeRunId'
    | 'pendingFinal'
    | 'sending'
    | 'runAborted'
    | 'lastUserMessageAt'
    | 'streamingMessage'
    | 'messagesSnapshot'
  > | null;
};

/** Sidebar session row status — same finalize rules for current and background sessions. */
function isBackgroundSidebarTurnComplete(
  snapshot: NonNullable<DeriveSidebarSessionIsExecutingInput['snapshot']>,
  gatewayBackground: GatewayBackgroundActivity | null | undefined,
): boolean {
  if (snapshot.runAborted) return true;

  const messages = snapshot.messagesSnapshot ?? [];
  if (messages.length === 0) return false;

  // Still receiving partial stream content for a background session.
  if (snapshot.sending && snapshot.streamingMessage != null) return false;

  const processingKeys = gatewayBackground?.processingSessionKeys ?? [];
  if (isParentDelegationPhaseOpen(messages, processingKeys, {
    lastUserMessageAt: snapshot.lastUserMessageAt ?? null,
    streamingMessage: snapshot.streamingMessage ?? null,
  })) {
    return false;
  }

  const terminal = findTerminalAssistantForActiveTurn(
    messages,
    snapshot.lastUserMessageAt ?? null,
  );
  if (!terminal) return false;

  if (shouldKeepRunActiveAfterAssistantFinal(terminal)) {
    return isVisibleAssistantTextWithoutToolUse(terminal);
  }

  return true;
}

/** Sidebar session row status 锟?same finalize rules for current and background sessions. */
export function deriveSidebarSessionIsExecuting(
  input: DeriveSidebarSessionIsExecutingInput,
): boolean {
  const processingKeys = input.gatewayBackground?.processingSessionKeys ?? [];

  if (!input.isCurrent) {
    if (isUserAbortedSession(input.sessionKey) || input.snapshot?.runAborted) {
      return false;
    }
  }

  if (!input.isCurrent && processingKeys.includes(input.sessionKey)) {
    if (input.snapshot && isBackgroundSidebarTurnComplete(input.snapshot, input.gatewayBackground)) {
      return false;
    }
    return true;
  }

  if (input.isCurrent) {
    return deriveIsExecuting(
      input.currentUi,
      backendActivityForSession(input.sessionBackendActivity, input.sessionKey),
      {
        waitingOnSubagentDelegation: input.waitingOnSubagentDelegation,
        gatewayBackground: input.gatewayBackground,
        messages: input.currentMessages,
        lastUserMessageAt: input.currentLastUserMessageAt,
        streamingMessage: input.currentStreamingMessage,
        sessionKey: input.sessionKey,
      },
    );
  }

  const snapshot = input.snapshot;
  if (!snapshot) return false;

  const messages = snapshot.messagesSnapshot ?? [];
  return deriveIsExecuting(
    {
      sending: snapshot.sending ?? false,
      activeRunId: snapshot.activeRunId ?? null,
      pendingFinal: snapshot.pendingFinal ?? false,
      runAborted: snapshot.runAborted ?? false,
    },
    null,
    {
      waitingOnSubagentDelegation: isParentDelegationPhaseOpen(messages, processingKeys, {
        lastUserMessageAt: snapshot.lastUserMessageAt ?? null,
        streamingMessage: snapshot.streamingMessage ?? null,
      }),
      gatewayBackground: input.gatewayBackground,
      messages,
      lastUserMessageAt: snapshot.lastUserMessageAt ?? null,
      streamingMessage: snapshot.streamingMessage ?? null,
      sessionKey: input.sessionKey,
    },
  );
}

export type CanClearUserTurnInput = {
  messages: RawMessage[];
  lastUserMessageAt: number | null;
  backendActivity: SessionBackendActivity | null | undefined;
  terminalMessage?: RawMessage;
  gatewayBackground?: GatewayBackgroundActivity | null;
  /** Wall-clock start while gateway is idle but transcript still blocks finalize. */
  finalizeGraceStartedAt?: number | null;
  nowMs?: number;
};

/** After parent terminal + gateway idle, release UI if transcript delegation never clears. */
export const DELEGATION_FINALIZE_GRACE_MS = 30_000;

/**
 * Transcript-only delegation signals (spawn bindings, waiting markers).
 * Does not include gateway strong metrics.
 */
function silentDelegationFinalWouldHideUnansweredTurn(
  messages: RawMessage[],
  lastUserMessageAt: number | null,
  terminalMessage?: RawMessage,
): boolean {
  if (!terminalMessage || !shouldSilentlyFinalizeRunOnAssistantFinal(terminalMessage)) return false;
  if (!hasDelegationSpawnForActiveTurn(messages, { lastUserMessageAt })) return false;
  return !hasVisibleAssistantReplyForActiveTurn(messages, lastUserMessageAt);
}
export function hasTranscriptDelegationBlock(
  messages: RawMessage[],
  gatewayBackground?: GatewayBackgroundActivity | null,
  lastUserMessageAt?: number | null,
): boolean {
  return isParentDelegationPhaseOpen(
    messages,
    gatewayBackground?.processingSessionKeys ?? [],
    { lastUserMessageAt },
  );
}

/** Gateway idle but transcript still looks like delegation is open. */
export function isTranscriptOnlyDelegationDefer(
  messages: RawMessage[],
  gatewayBackground?: GatewayBackgroundActivity | null,
  backendActivity?: SessionBackendActivity | null,
  lastUserMessageAt?: number | null,
): boolean {
  if (hasOpenBackendWorkForUserTurn(gatewayBackground, backendActivity, messages)) return false;
  return hasTranscriptDelegationBlock(messages, gatewayBackground, lastUserMessageAt);
}

/**
 * Gateway-driven open work for the parent turn. Does not infer spawn tools 锟?
 * the model decides delegation; we only observe gateway + transcript bindings.
 */
export function hasOpenDelegatedBackendWork(
  messages: RawMessage[],
  gatewayBackground?: GatewayBackgroundActivity | null,
  backendActivity?: SessionBackendActivity | null,
  options?: {
    lastUserMessageAt?: number | null;
    streamingMessage?: unknown | null;
  },
): boolean {
  if (hasOpenBackendWorkForUserTurn(gatewayBackground, backendActivity, messages)) return true;
  return isParentDelegationPhaseOpen(
    messages,
    gatewayBackground?.processingSessionKeys ?? [],
    {
      lastUserMessageAt: options?.lastUserMessageAt,
      streamingMessage: options?.streamingMessage,
    },
  );
}

/** @deprecated Prefer hasOpenDelegatedBackendWork */
export function hasOpenSubagentDelegation(
  messages: RawMessage[],
  gatewayBackground?: GatewayBackgroundActivity | null,
  streamingMessage?: unknown | null,
  backendActivity?: SessionBackendActivity | null,
  lastUserMessageAt?: number | null,
): boolean {
  return hasOpenDelegatedBackendWork(
    messages,
    gatewayBackground,
    backendActivity,
    { lastUserMessageAt, streamingMessage },
  );
}

/**
 * Unified push-path gate: never clear while gateway reports open work,
 * then apply terminal + strong-backend finalize rules.
 */
/**
 * Transcript already contains a user-visible answer but stale backend metrics
 * (e.g. lagging hasTrackedUserRun) still block canClearUserTurnNow.
 * Only used when the gateway is not actively processing this session or children.
 */
export function canForceClearOnVisibleCommittedReply(input: CanClearUserTurnInput): boolean {
  const terminal = input.terminalMessage
    ?? findTerminalAssistantForActiveTurn(input.messages, input.lastUserMessageAt)
    ?? findConcludingAssistantForActiveTurn(input.messages, input.lastUserMessageAt);
  if (!terminal) return false;
  if (!hasVisibleAssistantContent(terminal) && !isRunTerminalAssistantMessage(terminal)) return false;
  if (shouldKeepRunActiveAfterAssistantFinal(terminal) && !isVisibleAssistantTextWithoutToolUse(terminal)) {
    return false;
  }

  const sessionKey = input.backendActivity?.sessionKey;
  const processingKeys = input.gatewayBackground?.processingSessionKeys ?? [];
  if (sessionKey && processingKeys.includes(sessionKey)) return false;

  if (hasTranscriptDelegationBlock(
    input.messages,
    input.gatewayBackground,
    input.lastUserMessageAt,
  )) {
    return false;
  }

  return true;
}

/** Drop stale run UI from a leaving-session snapshot when the transcript already shows a done reply. */
export function sanitizeLeavingSessionStreamingSnapshot(
  snapshot: SessionStreamingState,
  options: {
    sessionKey: string;
    backendActivity?: SessionBackendActivity | null;
    gatewayBackground?: GatewayBackgroundActivity | null;
  },
): SessionStreamingState {
  if (snapshot.runAborted) return snapshot;
  if (!hasLocalRunSignals(snapshot)) return snapshot;

  const messages = snapshot.messagesSnapshot ?? [];
  if (messages.length === 0) return snapshot;

  const backendActivity = options.backendActivity?.sessionKey === options.sessionKey
    ? options.backendActivity
    : {
      sessionKey: options.sessionKey,
      status: null,
      processing: false,
      hasTrackedUserRun: false,
      activeRunIds: [],
    };

  if (!canForceClearOnVisibleCommittedReply({
    messages,
    lastUserMessageAt: snapshot.lastUserMessageAt,
    backendActivity,
    gatewayBackground: options.gatewayBackground ?? null,
  })) {
    return snapshot;
  }

  return {
    ...snapshot,
    sending: false,
    pendingFinal: false,
    activeRunId: null,
    streamingText: '',
    streamingMessage: null,
    streamingTools: [],
    pendingToolImages: [],
    activeTool: null,
  };
}

export function canClearUserTurnNow(input: CanClearUserTurnInput): boolean {
  const nowMs = input.nowMs ?? Date.now();

  if (hasOpenBackendWorkForUserTurn(
    input.gatewayBackground,
    input.backendActivity,
    input.messages,
  )) {
    return false;
  }

  const transcriptBlocked = hasTranscriptDelegationBlock(
    input.messages,
    input.gatewayBackground,
    input.lastUserMessageAt,
  );
  if (transcriptBlocked) {
    const graceStartedAt = input.finalizeGraceStartedAt;
    const graceElapsed = graceStartedAt != null
      && nowMs - graceStartedAt >= DELEGATION_FINALIZE_GRACE_MS;
    if (!graceElapsed) {
      return false;
    }
    const terminal = input.terminalMessage
      ?? findTerminalAssistantForActiveTurn(input.messages, input.lastUserMessageAt);
    if (!terminal || shouldKeepRunActiveAfterAssistantFinal(terminal)) {
      return false;
    }
    if (silentDelegationFinalWouldHideUnansweredTurn(input.messages, input.lastUserMessageAt, terminal)) {
      return false;
    }
    return true;
  }

  return shouldFinalizeUserTurn(
    input.messages,
    input.lastUserMessageAt,
    input.backendActivity,
    input.terminalMessage,
    input.gatewayBackground,
  );
}

export function buildKeepUserTurnOpenPatch(
  activeRunId?: string | null,
): Pick<UserTurnUiSignals, 'sending' | 'pendingFinal' | 'activeRunId'> {
  return {
    sending: true,
    pendingFinal: true,
    activeRunId: activeRunId ?? null,
  };
}

/**
 * Finalize only when the transcript has a terminal assistant for the active turn
 * and the gateway no longer tracks a strong active run for this session.
 */
export function shouldFinalizeUserTurn(
  messages: RawMessage[],
  lastUserMessageAt: number | null,
  backendActivity: SessionBackendActivity | null | undefined,
  terminalMessage?: RawMessage,
  gatewayBackground?: GatewayBackgroundActivity | null,
): boolean {
  if (hasOpenBackendWorkForUserTurn(gatewayBackground, backendActivity, messages)) return false;
  if (hasTranscriptDelegationBlock(messages, gatewayBackground, lastUserMessageAt)) return false;
  const strictTerminal = terminalMessage
    ?? findTerminalAssistantForActiveTurn(messages, lastUserMessageAt);
  if (strictTerminal) {
    if (silentDelegationFinalWouldHideUnansweredTurn(messages, lastUserMessageAt, strictTerminal)) {
      return false;
    }
    if (shouldKeepRunActiveAfterAssistantFinal(strictTerminal)) {
      return isVisibleAssistantTextWithoutToolUse(strictTerminal);
    }
    return !isBackendStronglyActive(backendActivity);
  }
  const concluding = findConcludingAssistantForActiveTurn(messages, lastUserMessageAt);
  if (!concluding) return false;
  return !isBackendStronglyActive(backendActivity);
}

/** Whether a stuck-run timeout should abort and clear UI state. */
export function shouldForceAbortStuckRun(
  backendActivity: SessionBackendActivity | null | undefined,
  gatewayBackground?: GatewayBackgroundActivity | null,
  messages: RawMessage[] = [],
): boolean {
  return !hasOpenBackendWorkForUserTurn(gatewayBackground, backendActivity, messages);
}

export function buildReAdoptRunPatch(
  state: UserTurnUiSignals & {
    currentSessionKey?: string;
    runAborted?: boolean;
    messages?: RawMessage[];
    lastUserMessageAt?: number | null;
  },
  sessionKey: string,
  backendActivity: SessionBackendActivity | null | undefined,
  gatewayBackground?: GatewayBackgroundActivity | null,
): Partial<UserTurnUiSignals & { activeRunId: string | null; pendingFinal: boolean; sending: boolean }> | null {
  if (isUserAbortedSession(sessionKey)) {
    return null;
  }
  if (state.runAborted) {
    return null;
  }
  if (state.currentSessionKey != null && state.currentSessionKey !== sessionKey) {
    return null;
  }
  const messages = state.messages ?? [];
  const processingKeys = gatewayBackground?.processingSessionKeys ?? [];
  if (isDelegationWrapUpComplete(messages, processingKeys, {
    lastUserMessageAt: state.lastUserMessageAt,
  })) {
    return null;
  }
  if (!hasOpenBackendWorkForUserTurn(gatewayBackground, backendActivity, messages)) {
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
