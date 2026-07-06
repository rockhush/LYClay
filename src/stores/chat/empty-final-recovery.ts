import { getEmptyFinalDiagnostic } from '@/lib/host-api';
import { isParentDelegationPhaseOpen } from '@/lib/delegation-turn-state';
import {
  collectChildDelegationBindings,
  collectCompletedSubagentSessionKeys,
  hasInFlightSubagentSignals,
} from '@/lib/subagent-delegation';
import { hasNonToolAssistantContent } from './helpers';
import { deferClearUserTurnForOpenDelegation } from './finalize-turn-bridge';
import { clearHistoryPoll } from './helpers';
import { hasOpenDelegatedBackendWork } from './user-turn-lifecycle';
import type { ChatGet, ChatSet, ChatState, RawMessage } from './types';

export const EMPTY_FINAL_NO_RESPONSE_ERROR = 'Run ended without a response. Recover the session, then retry manually.';
export const EMPTY_FINAL_HISTORY_RETRY_MS = 2_000;

function countAssistantOutputs(messages: RawMessage[]): number {
  return messages.filter((message) => message.role === 'assistant' && hasNonToolAssistantContent(message)).length;
}

export function hasNewAssistantOutput(beforeMessages: RawMessage[], afterMessages: RawMessage[]): boolean {
  if (countAssistantOutputs(afterMessages) > countAssistantOutputs(beforeMessages)) {
    return true;
  }
  const beforeLastRole = beforeMessages.at(-1)?.role;
  const afterLast = afterMessages.at(-1);
  return beforeLastRole === 'user'
    && afterLast?.role === 'assistant'
    && hasNonToolAssistantContent(afterLast);
}

function waitForEmptyFinalRetry(): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, EMPTY_FINAL_HISTORY_RETRY_MS);
  });
}

function getRecoverySkipReason(diagnostic: Record<string, unknown> | null | undefined): string {
  const recoveryResult = diagnostic?.recoveryResult;
  if (recoveryResult && typeof recoveryResult === 'object') {
    const reason = (recoveryResult as Record<string, unknown>).reason;
    if (typeof reason === 'string' && reason.trim()) return reason;
  }
  return 'empty-final-no-output';
}

function isDiagnosticRecoverable(diagnostic: Record<string, unknown> | null | undefined): boolean {
  const recoveryResult = diagnostic?.recoveryResult;
  if (recoveryResult && typeof recoveryResult === 'object') {
    const reason = (recoveryResult as Record<string, unknown>).reason;
    if (reason === 'lock-too-new' || reason === 'session-active') return false;
  }

  const lockOwner = diagnostic?.transcriptLockOwner;
  if (lockOwner && typeof lockOwner === 'object') {
    const pidAlive = (lockOwner as Record<string, unknown>).pidAlive;
    if (pidAlive === true) return false;
  }

  return true;
}

function isStillConfirmingEmptyFinal(get: ChatGet, sessionKey: string, runId: string): boolean {
  const state = get();
  return state.currentSessionKey === sessionKey
    && (!runId || !state.activeRunId || state.activeRunId === runId);
}

function hasActiveRunningTool(get: ChatGet, sessionKey: string, runId: string): boolean {
  const state = get();
  const activeTool = state.currentSessionKey === sessionKey
    ? state.activeTool
    : state.sessionStreamingStates[sessionKey]?.activeTool;
  return Boolean(
    activeTool
      && activeTool.status === 'running'
      && (!runId || !activeTool.runId || activeTool.runId === runId),
  );
}

/** Whether an empty bare final should keep the user turn open for delegation/yield. */
export function shouldDeferEmptyFinalForOpenDelegation(state: ChatState): boolean {
  const processingKeys = state.gatewayBackgroundActivity?.processingSessionKeys ?? [];
  const messages = state.messages;

  if (hasInFlightSubagentSignals(messages, {
    streamingMessage: state.streamingMessage,
    processingSessionKeys: processingKeys,
  })) {
    return true;
  }

  if (hasOpenDelegatedBackendWork(
    messages,
    state.gatewayBackgroundActivity,
    state.sessionBackendActivity,
    {
      lastUserMessageAt: state.lastUserMessageAt,
      streamingMessage: state.streamingMessage,
    },
  )) {
    return true;
  }

  const completed = collectCompletedSubagentSessionKeys(messages);
  const bindings = collectChildDelegationBindings(messages, completed);
  if (bindings.some((binding) => !binding.completed)) {
    return true;
  }

  return isParentDelegationPhaseOpen(messages, processingKeys, {
    lastUserMessageAt: state.lastUserMessageAt,
    streamingMessage: state.streamingMessage,
  });
}

export function tryDeferEmptyFinalForOpenDelegation(
  set: ChatSet,
  get: ChatGet,
  context: { sessionKey: string; runId: string },
): boolean {
  const state = get();
  if (state.currentSessionKey !== context.sessionKey) return false;
  if (!shouldDeferEmptyFinalForOpenDelegation(state)) return false;

  const deferred = deferClearUserTurnForOpenDelegation(get, set, {
    sessionKey: context.sessionKey,
    runId: context.runId,
    messages: state.messages,
    streamingMessage: state.streamingMessage,
  });
  if (!deferred) return false;

  set({
    emptyFinalRecovery: { status: 'idle' },
    runError: null,
    pendingFinal: true,
  });
  return true;
}

function completeEmptyFinalFromHistory(set: ChatSet, get: ChatGet, sessionKey: string, runId: string): void {
  if (!isStillConfirmingEmptyFinal(get, sessionKey, runId)) return;
  if (shouldDeferEmptyFinalForOpenDelegation(get())) return;

  clearHistoryPoll();
  set({
    sending: false,
    activeRunId: null,
    streamingText: '',
    streamingMessage: null,
    streamingTools: [],
    pendingFinal: false,
    pendingToolImages: [],
    lastUserMessageAt: null,
    runError: null,
    emptyFinalRecovery: { status: 'idle' },
  });
}

async function reloadHistoryForEmptyFinal(get: ChatGet): Promise<void> {
  const loadHistory = get().loadHistory;
  if (loadHistory.length >= 2) {
    await loadHistory(true, { force: true });
    return;
  }
  await loadHistory(true);
}

export async function confirmEmptyFinalWithHistory(set: ChatSet, get: ChatGet, runId: string): Promise<void> {
  const sessionKey = get().currentSessionKey;
  const beforeMessages = [...get().messages];

  if (tryDeferEmptyFinalForOpenDelegation(set, get, { sessionKey, runId })) {
    await reloadHistoryForEmptyFinal(get);
    return;
  }

  set({
    streamingText: '',
    streamingMessage: null,
    pendingFinal: true,
    runError: null,
  });

  await reloadHistoryForEmptyFinal(get);

  if (tryDeferEmptyFinalForOpenDelegation(set, get, { sessionKey, runId })) {
    return;
  }

  if (isStillConfirmingEmptyFinal(get, sessionKey, runId) && hasNewAssistantOutput(beforeMessages, get().messages)) {
    completeEmptyFinalFromHistory(set, get, sessionKey, runId);
    return;
  }

  await waitForEmptyFinalRetry();
  if (!isStillConfirmingEmptyFinal(get, sessionKey, runId)) return;

  await reloadHistoryForEmptyFinal(get);

  if (tryDeferEmptyFinalForOpenDelegation(set, get, { sessionKey, runId })) {
    return;
  }

  if (!isStillConfirmingEmptyFinal(get, sessionKey, runId)) return;
  if (hasNewAssistantOutput(beforeMessages, get().messages)) {
    completeEmptyFinalFromHistory(set, get, sessionKey, runId);
    return;
  }

  if (hasActiveRunningTool(get, sessionKey, runId)) {
    set({
      emptyFinalRecovery: {
        status: 'waiting',
        sessionKey,
        runId,
        reason: 'tracked-active-tool',
        diagnostic: { activeTool: get().activeTool ?? get().sessionStreamingStates[sessionKey]?.activeTool ?? null },
      },
      runError: null,
      pendingFinal: true,
      sending: false,
      activeRunId: null,
    });
    return;
  }

  if (shouldDeferEmptyFinalForOpenDelegation(get())) {
    tryDeferEmptyFinalForOpenDelegation(set, get, { sessionKey, runId });
    return;
  }

  set({
    emptyFinalRecovery: {
      status: 'checking',
      sessionKey,
      runId,
    },
  });
  let diagnostic: Record<string, unknown> | null = null;
  let hasTrackedActiveRun = false;
  try {
    const response = await getEmptyFinalDiagnostic(sessionKey);
    diagnostic = response.diagnostic ?? null;
    hasTrackedActiveRun = Boolean(response.hasTrackedActiveRun);
  } catch (error) {
    diagnostic = { error: String(error) };
  }
  if (!isStillConfirmingEmptyFinal(get, sessionKey, runId)) return;

  if (hasTrackedActiveRun || !diagnostic || !isDiagnosticRecoverable(diagnostic)) {
    set({
      emptyFinalRecovery: {
        status: 'waiting',
        sessionKey,
        runId,
        reason: hasTrackedActiveRun ? 'tracked-active-run' : diagnostic ? getRecoverySkipReason(diagnostic) : 'missing-diagnostic',
        diagnostic,
      },
      runError: null,
      pendingFinal: true,
      sending: hasTrackedActiveRun ? true : get().sending,
      activeRunId: hasTrackedActiveRun ? (runId || get().activeRunId) : get().activeRunId,
    });
    return;
  }

  if (shouldDeferEmptyFinalForOpenDelegation(get())) {
    tryDeferEmptyFinalForOpenDelegation(set, get, { sessionKey, runId });
    return;
  }

  clearHistoryPoll();
  set({
    error: null,
    runError: EMPTY_FINAL_NO_RESPONSE_ERROR,
    emptyFinalRecovery: {
      status: 'stale',
      sessionKey,
      runId,
      reason: getRecoverySkipReason(diagnostic),
      diagnostic,
    },
    sending: false,
    activeRunId: null,
    streamingText: '',
    streamingMessage: null,
    streamingTools: [],
    pendingFinal: false,
    pendingToolImages: [],
    lastUserMessageAt: null,
  });
}
