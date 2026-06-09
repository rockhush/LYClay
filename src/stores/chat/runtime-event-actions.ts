import {
  clearHistoryPoll,
  collectToolUpdates,
  forgetAbortedChatRun,
  getMessageText,
  hasNonToolAssistantContent,
  isAbortedChatRun,
  isInternalMessageText,
  isToolOnlyMessage,
  isToolResultRole,
  normalizeStreamingMessage,
  setLastChatEventAt,
  upsertToolStatuses,
} from './helpers';
import type { RawMessage } from './types';
import type { ChatGet, ChatSet, RuntimeActions } from './store-api';
import { handleRuntimeEventState } from './runtime-event-handlers';
import type { RawMessage, SessionStreamingState } from './types';

function createEmptySessionStreamingState(): SessionStreamingState {
  return {
    activeRunId: null,
    streamingText: '',
    streamingMessage: null,
    streamingTools: [],
    pendingFinal: false,
    lastUserMessageAt: null,
    pendingToolImages: [],
    runAborted: false,
    sending: false,
    messagesSnapshot: [],
  };
}

function snapshotCurrentStreamingState(get: ChatGet): SessionStreamingState {
  const state = get();
  return {
    activeRunId: state.activeRunId,
    streamingText: state.streamingText,
    streamingMessage: state.streamingMessage,
    streamingTools: state.streamingTools,
    pendingFinal: state.pendingFinal,
    lastUserMessageAt: state.lastUserMessageAt,
    pendingToolImages: state.pendingToolImages,
    runAborted: state.runAborted,
    sending: state.sending,
    messagesSnapshot: state.messages.length > 0
      ? [...state.messages]
      : (state.sessionStreamingStates[state.currentSessionKey]?.messagesSnapshot ?? []),
  };
}

function appendMessageIfMissing(messages: RawMessage[], message: RawMessage): RawMessage[] {
  if (message.id && messages.some((existing) => existing.id === message.id)) return messages;
  return [...messages, message];
}

function applyBackgroundChatEvent(
  get: ChatGet,
  sessionKey: string,
  event: Record<string, unknown>,
  resolvedState: string,
  runId: string,
): Record<string, SessionStreamingState> | null {
  const state = get();
  const existing = state.sessionStreamingStates[sessionKey] ?? createEmptySessionStreamingState();
  if (existing.activeRunId && runId && runId !== existing.activeRunId) return null;

  const next: SessionStreamingState = { ...existing };
  if (runId && !next.activeRunId && (resolvedState === 'started' || resolvedState === 'delta')) {
    next.activeRunId = runId;
  }

  switch (resolvedState) {
    case 'started':
      next.sending = true;
      next.runAborted = false;
      break;
    case 'delta': {
      if (event.message && typeof event.message === 'object') {
        const msgObj = event.message as RawMessage;
        if (!isToolResultRole(msgObj.role)) {
          const msgContent = getMessageText(msgObj.content);
          next.streamingMessage = msgContent.trim() && isInternalMessageText(msgContent)
            ? null
            : normalizeStreamingMessage(event.message ?? next.streamingMessage);
        }
      } else if (event.message) {
        next.streamingMessage = normalizeStreamingMessage(event.message);
      }
      const updates = collectToolUpdates(event.message, resolvedState);
      next.streamingTools = updates.length > 0 ? upsertToolStatuses(next.streamingTools, updates) : next.streamingTools;
      next.sending = true;
      next.runAborted = false;
      break;
    }
    case 'final': {
      const finalMsg = event.message as RawMessage | undefined;
      if (finalMsg) {
        const normalized = normalizeStreamingMessage(finalMsg) as RawMessage;
        const content = getMessageText(normalized.content);
        const isInternal = content.trim() && isInternalMessageText(content);
        const toolOnly = isToolOnlyMessage(normalized);
        const hasOutput = hasNonToolAssistantContent(normalized);
        if (!isInternal && !isToolResultRole(normalized.role) && !toolOnly && hasOutput) {
          const msgId = normalized.id || `run-${runId || Date.now()}`;
          next.messagesSnapshot = appendMessageIfMissing(next.messagesSnapshot, {
            ...normalized,
            role: (normalized.role || 'assistant') as RawMessage['role'],
            id: msgId,
          });
        }
        if (isToolResultRole(normalized.role) || toolOnly) {
          const updates = collectToolUpdates(normalized, resolvedState);
          next.streamingTools = updates.length > 0 ? upsertToolStatuses(next.streamingTools, updates) : next.streamingTools;
          next.pendingFinal = true;
          next.sending = true;
          break;
        }
      }
      next.sending = false;
      next.activeRunId = null;
      next.streamingText = '';
      next.streamingMessage = null;
      next.streamingTools = [];
      next.pendingFinal = false;
      next.pendingToolImages = [];
      next.lastUserMessageAt = null;
      next.runAborted = false;
      break;
    }
    case 'error':
    case 'aborted':
      next.sending = false;
      next.activeRunId = null;
      next.streamingText = '';
      next.streamingMessage = null;
      next.streamingTools = [];
      next.pendingFinal = false;
      next.pendingToolImages = [];
      next.lastUserMessageAt = null;
      next.runAborted = false;
      break;
    default:
      return null;
  }

  return {
    ...state.sessionStreamingStates,
    [sessionKey]: next,
  };
}

/**
 * Decide whether a runtime event finishes the run for a session the user is NOT
 * currently viewing. Mirrors the terminal cases in `handleRuntimeEventState`
 * (real assistant output `final`, `aborted`, and finalized `error`) without
 * touching the top-level (current-session) streaming fields.
 */
function classifyBackgroundTermination(
  event: Record<string, unknown>,
  resolvedState: string,
): { completed: boolean; aborted: boolean } {
  if (resolvedState === 'aborted') {
    return { completed: true, aborted: true };
  }
  if (resolvedState === 'error') {
    const errorMsg = String(event.errorMessage || '').toLowerCase();
    const isAbortError = errorMsg.includes('abort');
    return { completed: true, aborted: isAbortError };
  }
  if (resolvedState === 'final') {
    const finalMsg = event.message as RawMessage | undefined;
    if (!finalMsg) {
      // A final without a message is itself a completion signal.
      return { completed: true, aborted: false };
    }
    const normalized = normalizeStreamingMessage(finalMsg) as RawMessage;
    const text = getMessageText(normalized.content);
    const isInternal = Boolean(text.trim()) && isInternalMessageText(text);
    // Tool steps and NO_REPLY/internal turns do not end the run; only a real
    // assistant response does.
    if (
      !isToolResultRole(normalized.role)
      && !isToolOnlyMessage(normalized)
      && hasNonToolAssistantContent(normalized)
      && !isInternal
    ) {
      return { completed: true, aborted: false };
    }
  }
  return { completed: false, aborted: false };
}

/**
 * Keep a background session's saved streaming state in sync when its run
 * finishes while the user is viewing a different session. Without this, the
 * stale `sending`/`activeRunId` snapshot causes the session to appear stuck on
 * "thinking…" forever and blocks the switch-back `loadHistory` that would
 * surface the completed answer.
 */
function finalizeBackgroundSessionRunIfCompleted(
  set: ChatSet,
  get: ChatGet,
  eventSessionKey: string,
  event: Record<string, unknown>,
  resolvedState: string,
  runId: string,
): void {
  const prev = get().sessionStreamingStates[eventSessionKey];
  if (!prev || (!prev.sending && !prev.activeRunId)) return;
  // Ignore events from a different run than the one tracked for this session.
  if (prev.activeRunId && runId && prev.activeRunId !== runId) return;

  const { completed, aborted } = classifyBackgroundTermination(event, resolvedState);
  if (!completed) return;

  set((s) => ({
    sessionStreamingStates: {
      ...s.sessionStreamingStates,
      [eventSessionKey]: {
        ...prev,
        sending: false,
        activeRunId: null,
        streamingText: '',
        streamingMessage: null,
        streamingTools: [],
        pendingFinal: false,
        lastUserMessageAt: null,
        pendingToolImages: [],
        runAborted: aborted,
        // Drop the snapshot so switching back triggers a fresh loadHistory()
        // that surfaces the authoritative, completed transcript.
        messagesSnapshot: [],
      },
    },
  }));
}

export function createRuntimeEventActions(set: ChatSet, get: ChatGet): Pick<RuntimeActions, 'handleChatEvent'> {
  return {
    handleChatEvent: (event: Record<string, unknown>) => {
      const runId = String(event.runId || '');
      const eventState = String(event.state || '');
      const eventSessionKey = event.sessionKey != null ? String(event.sessionKey) : null;
      const { activeRunId, currentSessionKey, sessionStreamingStates } = get();
      const inferredSessionKey = (() => {
        if (eventSessionKey != null) return eventSessionKey;
        if (!runId) return null;
        if (activeRunId && runId === activeRunId) return currentSessionKey;
        for (const [sessionKey, state] of Object.entries(sessionStreamingStates)) {
          if (state.activeRunId === runId) return sessionKey;
        }
        return null;
      })();
      const resolvedSessionKey = eventSessionKey ?? inferredSessionKey;
      const isForegroundEvent = !resolvedSessionKey || resolvedSessionKey === currentSessionKey;
      const backgroundSessionState = resolvedSessionKey ? sessionStreamingStates[resolvedSessionKey] : undefined;

      // If the event targets a different session, only accept it if it belongs to
      // a known background run or if it is the start of a new run in that session.
      if (!isForegroundEvent) {
        const isKnownBackgroundRun = !!backgroundSessionState && backgroundSessionState.activeRunId === runId;
        const isPotentialStart = eventState === 'started';
        if (!isKnownBackgroundRun && !isPotentialStart) {
          return;
        }
      }

      // Only process events for the active run on the foreground session,
      // or for a matching known background run.
      if (activeRunId && runId && runId !== activeRunId) {
        const isCurrentRun = resolvedSessionKey == null || resolvedSessionKey === currentSessionKey;
        const isKnownBackgroundRun = resolvedSessionKey != null
          && sessionStreamingStates[resolvedSessionKey]?.activeRunId === runId;
        if (isCurrentRun || !isKnownBackgroundRun) return;
      }

      setLastChatEventAt(Date.now());
      const isCurrentSessionEvent = eventSessionKey == null || eventSessionKey === currentSessionKey;

      // Defensive: if state is missing but we have a message, try to infer state.
      let resolvedState = eventState;
      if (!resolvedState && event.message && typeof event.message === 'object') {
        const msg = event.message as Record<string, unknown>;
        const stopReason = msg.stopReason ?? msg.stop_reason;
        if (stopReason) {
          resolvedState = 'final';
        } else if (msg.role || msg.content) {
          resolvedState = 'delta';
        }
      }

      // Events for a session the user isn't currently viewing must not mutate
      // the visible (current-session) streaming fields, but we still need to
      // finalize that background session's saved state so switching back shows
      // the completed answer instead of a frozen "thinking…" state.
      if (eventSessionKey != null && eventSessionKey !== currentSessionKey) {
        finalizeBackgroundSessionRunIfCompleted(set, get, eventSessionKey, event, resolvedState, runId);
        return;
      }

      // Only process events for the active run (or if no active run set)
      if (!isCurrentSessionEvent) {
        setLastChatEventAt(Date.now());
        if (runId && isAbortedChatRun(runId)) {
          if (resolvedState === 'aborted' || resolvedState === 'final' || resolvedState === 'error') {
            forgetAbortedChatRun(runId);
          } else {
            return;
          }
        }
        const nextSessionStreamingStates = applyBackgroundChatEvent(get, eventSessionKey, event, resolvedState, runId);
        if (nextSessionStreamingStates) {
          set({ sessionStreamingStates: nextSessionStreamingStates });
        }
        return;
      }

      if (activeRunId && runId && runId !== activeRunId) return;

      setLastChatEventAt(Date.now());

      if (runId && isAbortedChatRun(runId)) {
        if (resolvedState === 'aborted' || resolvedState === 'final' || resolvedState === 'error') {
          forgetAbortedChatRun(runId);
        } else {
          return;
        }
      }

      const hasUsefulData = resolvedState === 'delta' || resolvedState === 'final'
        || resolvedState === 'error' || resolvedState === 'aborted';
      if (hasUsefulData) {
        clearHistoryPoll();
        if (isForegroundEvent) {
          const { sending } = get();
          if (!sending && runId && !isAbortedChatRun(runId)) {
            set({ sending: true, activeRunId: runId, error: null });
          }
        }
      }

      handleRuntimeEventState(set, get, event, resolvedState, runId);
      set((s) => ({
        sessionStreamingStates: {
          ...s.sessionStreamingStates,
          [s.currentSessionKey]: snapshotCurrentStreamingState(get),
        },
      }));
    },
  };
}
