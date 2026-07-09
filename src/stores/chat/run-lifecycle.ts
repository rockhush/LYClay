import {
  getMessageText,
  hasVisibleAssistantContent,
  isChannelDeliveryConfirmationText,
  isInternalMessageText,
  stripSilentReplyToken,
} from './helpers';
import type { ChatState, RawMessage } from './types';
import { extractToolUse } from '@/pages/Chat/message-utils';
import { isInterimSubagentWaitAssistantReply } from '@/lib/subagent-delegation';

function isPartialDelegationWaitReply(message: RawMessage): boolean {
  if (message.role !== 'assistant') return false;
  const text = getMessageText(message.content).trim();
  if (!text) return false;
  if (/(?:继续等待|continue\s+waiting|waiting\s+(?:for\s+)?Phase|等待\s*Phase)/i.test(text)) return true;
  if (/(?:已完成|完成了|also completed|completed).{0,48}(?:继续|等待|waiting)/i.test(text)) return true;
  return /(?:Phase\s*\d+).{0,40}(?:完成|completed).{0,48}(?:继续|等待|waiting)/i.test(text);
}

function containsSilentReplyToken(text: string): boolean {
  return /\b(?:NO_REPLY|HEARTBEAT_OK)\b/i.test(text);
}

function isToolResultRole(role: unknown): boolean {
  if (!role) return false;
  const normalized = String(role).toLowerCase();
  return normalized === 'toolresult' || normalized === 'tool_result' || normalized === 'tool';
}

function messageHasToolUse(message: RawMessage): boolean {
  return extractToolUse(message).length > 0;
}

function isSubagentCompletionEventMessage(message: RawMessage | undefined): boolean {
  if (!message || message.role !== 'assistant') return false;
  const text = getMessageText(message.content);
  return text.includes('[Internal task completion event]')
    && /session_key:\s*\S+/i.test(text)
    && /session_id:\s*\S+/i.test(text);
}

const RENDERER_SYNTHETIC_RUN_ID = /^run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(-tool-\d+)?$/i;

/** Optimistic assistant finals appended by the renderer (`run-<uuid>`), not authoritative JSONL. */
export function isRendererSyntheticRunMessage(message: RawMessage | undefined): boolean {
  if (!message?.id || typeof message.id !== 'string') return false;
  return RENDERER_SYNTHETIC_RUN_ID.test(message.id);
}

/** Drop renderer-only run finals when the authoritative transcript already has assistant turns. */
export function stripRendererSyntheticRunMessages(messages: RawMessage[]): RawMessage[] {
  if (messages.length === 0) return messages;
  const hasAuthoritativeAssistant = messages.some((message) =>
    message.role === 'assistant' && !isRendererSyntheticRunMessage(message),
  );
  if (!hasAuthoritativeAssistant) return messages;
  const filtered = messages.filter((message) => !isRendererSyntheticRunMessage(message));
  return filtered.length === messages.length ? messages : filtered;
}

/** Gateway finals may carry cumulative stream text across tool rounds — detect and skip. */
export function isCumulativeRunFinalText(
  candidateText: string,
  turnMessages: readonly RawMessage[],
): boolean {
  const trimmed = candidateText.trim();
  if (!trimmed) return false;

  const priorTexts = turnMessages
    .filter((message) => message.role === 'assistant' && !isRendererSyntheticRunMessage(message))
    .map((message) => getMessageText(message.content).trim())
    .filter((text) => text.length >= 24);

  let embeddedPriorCount = 0;
  for (const prior of priorTexts) {
    if (trimmed.includes(prior)) embeddedPriorCount += 1;
  }
  if (embeddedPriorCount >= 2) return true;

  const longestPrior = priorTexts.reduce((max, text) => Math.max(max, text.length), 0);
  return embeddedPriorCount >= 1 && longestPrior >= 40 && trimmed.length > longestPrior * 1.4;
}

export function isVisibleAssistantTextWithoutToolUse(message: RawMessage | undefined): boolean {
  if (!message || message.role !== 'assistant') return false;
  if (!hasVisibleAssistantContent(message)) return false;
  return !messageHasToolUse(message);
}

function findLastToolActivityIndex(messages: readonly RawMessage[]): number {
  let last = -1;
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]!;
    if (message.role === 'assistant' && messageHasToolUse(message)) last = i;
    else if (isToolResultRole(message.role)) last = i;
  }
  return last;
}
export function isExplicitAssistantStopReason(stopReason: unknown): boolean {
  if (stopReason == null) return false;
  const normalized = String(stopReason).toLowerCase();
  return normalized === 'stop'
    || normalized === 'error'
    || normalized === 'abort'
    || normalized === 'aborted'
    || normalized === 'cancelled'
    || normalized === 'canceled';
}

export function isFailedAssistantStopReason(stopReason: unknown): boolean {
  if (stopReason == null) return false;
  const normalized = String(stopReason).toLowerCase();
  return normalized === 'aborted'
    || normalized === 'error'
    || normalized === 'cancelled'
    || normalized === 'canceled';
}

export function getAssistantStopReason(message: RawMessage): unknown {
  const msg = message as RawMessage & { stopReason?: unknown; stop_reason?: unknown };
  return msg.stopReason ?? msg.stop_reason;
}

export function getAssistantErrorMessage(message: RawMessage | undefined): string | null {
  if (!message) return null;
  const msg = message as RawMessage & { errorMessage?: unknown; error_message?: unknown; error?: unknown };
  const value = msg.errorMessage ?? msg.error_message ?? msg.error;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Assistant turn that ended because the runtime/provider aborted or errored. */
export function isFailedAssistantMessage(message: RawMessage | undefined): boolean {
  if (!message || message.role !== 'assistant') return false;
  if (isFailedAssistantStopReason(getAssistantStopReason(message))) return true;
  return Boolean(getAssistantErrorMessage(message));
}

/** Gateway-injected notice when the embedded agent errors before a model reply. */
export function isEmbeddedAgentFailureNoticeAssistantMessage(message: RawMessage | undefined): boolean {
  if (!message || message.role !== 'assistant') return false;
  const text = getMessageText(message.content).trim();
  if (!text) return false;
  return /^⚠️?\s*Agent failed before reply:/i.test(text)
    || /^All models failed\s*\(/i.test(text);
}

/** Assistant turn that ended to invoke tools — not a user-visible concluding answer. */
export function isToolUseStopReasonAssistantMessage(message: RawMessage | undefined): boolean {
  if (!message || message.role !== 'assistant') return false;
  const stop = String(getAssistantStopReason(message) ?? '').toLowerCase();
  return stop === 'tooluse' || stop === 'tool_use';
}

/** Visible assistant reply with an explicit non-tool stop reason. */
export function isTerminalAssistantMessage(message: RawMessage | undefined): boolean {
  if (!message || message.role !== 'assistant') return false;
  if (isFailedAssistantMessage(message)) return false;
  if (!hasVisibleAssistantContent(message)) return false;
  return isExplicitAssistantStopReason(getAssistantStopReason(message));
}

/**
 * Whitelist: assistant finals that should clear the active run without user-visible output.
 * UI hiding (`isInternalMessageText`) is broader; do not use that blacklist here.
 */
export function shouldSilentlyFinalizeRunOnAssistantFinal(message: RawMessage | undefined): boolean {
  if (!message || message.role !== 'assistant') return false;
  if (isFailedAssistantMessage(message)) return false;

  const rawText = getMessageText(message.content).trim();
  if (!rawText) return false;

  if (/^\[?OpenClaw heartbeat poll\]?\s*$/i.test(rawText)) return true;

  const hasTerminalStop = isExplicitAssistantStopReason(getAssistantStopReason(message));
  if (!hasTerminalStop) return false;

  if (/^(HEARTBEAT_OK|NO_REPLY)\s*$/i.test(rawText)) return true;
  if (containsSilentReplyToken(rawText) && stripSilentReplyToken(rawText).trim().length === 0) return true;

  const visibleText = stripSilentReplyToken(rawText).trim();
  if (visibleText && isChannelDeliveryConfirmationText(visibleText)) return true;

  return false;
}

/** Silent assistant reply (NO_REPLY / HEARTBEAT_OK) that closes the run. */
export function isSilentTerminalAssistantMessage(message: RawMessage | undefined): boolean {
  return shouldSilentlyFinalizeRunOnAssistantFinal(message);
}

export function isRunTerminalAssistantMessage(message: RawMessage | undefined): boolean {
  return isTerminalAssistantMessage(message) || isSilentTerminalAssistantMessage(message);
}

/** Non-terminal assistant finals (tool rounds, narration-before-tools) must keep the run active. */
export function shouldKeepRunActiveAfterAssistantFinal(message: RawMessage | undefined): boolean {
  if (!message || message.role !== 'assistant') return false;
  return !isRunTerminalAssistantMessage(message);
}

function isVisibleUserMessage(message: RawMessage): boolean {
  if (message.role !== 'user') return false;
  return !isInternalMessageText(getMessageText(message.content));
}

export function findLatestVisibleUserIndex(messages: RawMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (isVisibleUserMessage(messages[i])) return i;
  }
  return -1;
}

/** Terminal assistant turn after the latest visible user message in a transcript. */
export function findTerminalAssistantAfterLatestUser(messages: RawMessage[]): RawMessage | undefined {
  const userIdx = findLatestVisibleUserIndex(messages);
  const afterUser = userIdx >= 0 ? messages.slice(userIdx + 1) : messages;
  return [...afterUser].reverse().find((message) =>
    message.role === 'assistant'
    && !isRendererSyntheticRunMessage(message)
    && !isSubagentCompletionEventMessage(message)
    && !isPartialDelegationWaitReply(message)
    && isRunTerminalAssistantMessage(message),
  );
}

function toMs(ts: number): number {
  return ts < 1e12 ? Math.round(ts * 1000) : Math.round(ts);
}

/**
 * Terminal assistant for the active user turn. Uses the merged transcript view
 * (including optimistic user messages) and rejects terminal replies that predate
 * `lastUserMessageAt` when history loading lags behind the in-flight send.
 */
export function findTerminalAssistantForActiveTurn(
  messages: RawMessage[],
  lastUserMessageAt: number | null,
): RawMessage | undefined {
  const terminal = findTerminalAssistantAfterLatestUser(messages);
  if (!terminal || lastUserMessageAt == null) return terminal;
  const turnStartMs = toMs(lastUserMessageAt);
  const terminalMs = terminal.timestamp != null ? toMs(terminal.timestamp) : null;
  if (terminalMs != null && terminalMs < turnStartMs) return undefined;
  return terminal;
}

/**
 * User-visible text-only assistant reply after the last tool activity in a slice.
 * OpenClaw transcripts often omit stopReason on the real final answer even though
 * the run is complete �?use this for finalize and UI desync recovery.
 */
export function findConcludingAssistantReply(
  messages: readonly RawMessage[],
): RawMessage | undefined {
  if (messages.length === 0) return undefined;
  const lastToolIdx = findLastToolActivityIndex(messages);
  if (lastToolIdx < 0) return undefined;

  for (let i = messages.length - 1; i > lastToolIdx; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== 'assistant') continue;
    if (isRendererSyntheticRunMessage(message)) continue;
    if (isSubagentCompletionEventMessage(message)) continue;
    if (isPartialDelegationWaitReply(message)) continue;
    if (isEmbeddedAgentFailureNoticeAssistantMessage(message)) continue;
    if (isRunTerminalAssistantMessage(message)) return message;
    if (isFailedAssistantMessage(message)) continue;
    if (!hasVisibleAssistantContent(message)) continue;
    if (messageHasToolUse(message)) {
      const hasLaterToolUse = messages.slice(i + 1).some((later) =>
        later.role === 'assistant' && messageHasToolUse(later),
      );
      if (hasLaterToolUse) continue;
      // Gateway finals may bundle visible text with co-located tool_use blocks.
      return message;
    }
    const hasLaterToolUse = messages.slice(i + 1).some((later) =>
      later.role === 'assistant' && messageHasToolUse(later),
    );
    if (hasLaterToolUse) continue;
    return message;
  }

  const lastActivity = messages[lastToolIdx];
  if (lastActivity?.role === 'assistant' && hasVisibleAssistantContent(lastActivity)) {
    if (isRunTerminalAssistantMessage(lastActivity)) return lastActivity;
    if (!isFailedAssistantMessage(lastActivity)) {
      const hasLaterToolUse = messages.slice(lastToolIdx + 1).some((later) =>
        later.role === 'assistant' && messageHasToolUse(later),
      );
      if (!hasLaterToolUse) return lastActivity;
    }
  }
  return undefined;
}

export function isConcludingAssistantReply(
  message: RawMessage | undefined,
  messages: readonly RawMessage[],
): boolean {
  if (!message) return false;
  const concluding = findConcludingAssistantReply(messages);
  return concluding != null && concluding === message;
}

export function findConcludingAssistantForActiveTurn(
  messages: RawMessage[],
  lastUserMessageAt: number | null,
): RawMessage | undefined {
  const userIdx = findLatestVisibleUserIndex(messages);
  const turnMessages = userIdx >= 0 ? messages.slice(userIdx + 1) : messages;
  const concluding = findConcludingAssistantReply(turnMessages);
  if (!concluding || lastUserMessageAt == null) return concluding;
  const turnStartMs = toMs(lastUserMessageAt);
  const concludingMs = concluding.timestamp != null ? toMs(concluding.timestamp) : null;
  if (concludingMs != null && concludingMs < turnStartMs) return undefined;
  return concluding;
}

/** Recover turn anchor when UI cleared lastUserMessageAt while the same user turn is still open. */
export function resolveActiveTurnLastUserMessageAt(
  messages: RawMessage[],
  lastUserMessageAt: number | null,
): number | null {
  if (lastUserMessageAt != null) return lastUserMessageAt;
  const userIdx = findLatestVisibleUserIndex(messages);
  if (userIdx < 0) return null;
  const user = messages[userIdx];
  if (user?.timestamp == null) return null;
  return toMs(user.timestamp);
}

/** Transcript already contains a user-visible concluding answer for the active turn. */
export function transcriptHasCommittedConcludingReply(
  messages: RawMessage[],
  lastUserMessageAt: number | null,
): boolean {
  const turnAnchor = resolveActiveTurnLastUserMessageAt(messages, lastUserMessageAt);
  const terminal = findTerminalAssistantForActiveTurn(messages, turnAnchor);
  if (terminal) {
    if (isPartialDelegationWaitReply(terminal) || isInterimSubagentWaitAssistantReply(terminal)) {
      return false;
    }
    if (!isRunTerminalAssistantMessage(terminal)) return false;
    return true;
  }
  const userIdx = findLatestVisibleUserIndex(messages);
  const turnMessages = userIdx >= 0 ? messages.slice(userIdx + 1) : messages;
  const concluding = findConcludingAssistantForActiveTurn(messages, turnAnchor);
  if (!concluding || !hasVisibleAssistantContent(concluding)) return false;
  if (!isConcludingAssistantReply(concluding, turnMessages)) return false;
  if (isPartialDelegationWaitReply(concluding) || isInterimSubagentWaitAssistantReply(concluding)) {
    return false;
  }
  if (isToolUseStopReasonAssistantMessage(concluding)) return false;
  return true;
}

/** User-visible assistant reply committed in the active turn, ignoring silent plumbing finals. */
export function findVisibleAssistantReplyForActiveTurn(
  messages: RawMessage[],
  lastUserMessageAt: number | null,
): RawMessage | undefined {
  const userIdx = findLatestVisibleUserIndex(messages);
  const turnMessages = userIdx >= 0 ? messages.slice(userIdx + 1) : messages;
  const lastToolIdx = findLastToolActivityIndex(turnMessages);
  const startIdx = lastToolIdx >= 0 ? lastToolIdx + 1 : 0;
  const turnStartMs = lastUserMessageAt != null ? toMs(lastUserMessageAt) : null;

  for (let i = turnMessages.length - 1; i >= startIdx; i -= 1) {
    const message = turnMessages[i];
    if (!message || message.role !== 'assistant') continue;
    if (isRendererSyntheticRunMessage(message)) continue;
    if (isSubagentCompletionEventMessage(message)) continue;
    if (isFailedAssistantMessage(message)) continue;
    if (shouldSilentlyFinalizeRunOnAssistantFinal(message)) continue;
    if (messageHasToolUse(message)) continue;
    if (!hasVisibleAssistantContent(message)) continue;
    const messageMs = message.timestamp != null ? toMs(message.timestamp) : null;
    if (turnStartMs != null && messageMs != null && messageMs < turnStartMs) continue;
    return message;
  }

  return undefined;
}

export function hasVisibleAssistantReplyForActiveTurn(
  messages: RawMessage[],
  lastUserMessageAt: number | null,
): boolean {
  return findVisibleAssistantReplyForActiveTurn(messages, lastUserMessageAt) != null;
}
/** Terminal stopReason or post-tool concluding text already committed in transcript. */
export function hasCommittedUserReplyInMessages(messages: readonly RawMessage[]): boolean {
  if (messages.some((message) => isRunTerminalAssistantMessage(message))) return true;
  return findConcludingAssistantReply(messages) != null;
}

export function buildClearedActiveRunPatch(
  options?: { preserveTurnAnchor?: boolean },
): Partial<ChatState> {
  return {
    sending: false,
    activeRunId: null,
    pendingFinal: false,
    streamingText: '',
    streamingMessage: null,
    streamingTools: [],
    pendingToolImages: [],
    ...(options?.preserveTurnAnchor ? {} : { lastUserMessageAt: null }),
    runAborted: false,
    error: null,
    runError: null,
  };
}
