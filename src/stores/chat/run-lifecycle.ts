import {
  getMessageText,
  hasVisibleAssistantContent,
  isChannelDeliveryConfirmationText,
  isInternalMessageText,
  stripSilentReplyToken,
} from './helpers';
import type { ChatState, RawMessage } from './types';
import { extractToolUse } from '@/pages/Chat/message-utils';

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
    message.role === 'assistant' && isRunTerminalAssistantMessage(message),
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
 * the run is complete — use this for finalize and UI desync recovery.
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
    if (isRunTerminalAssistantMessage(message)) return message;
    if (isFailedAssistantMessage(message)) continue;
    if (!hasVisibleAssistantContent(message)) continue;
    if (messageHasToolUse(message)) continue;
    const hasLaterToolUse = messages.slice(i + 1).some((later) =>
      later.role === 'assistant' && messageHasToolUse(later),
    );
    if (hasLaterToolUse) continue;
    return message;
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

/** Terminal stopReason or post-tool concluding text already committed in transcript. */
export function hasCommittedUserReplyInMessages(messages: readonly RawMessage[]): boolean {
  if (messages.some((message) => isRunTerminalAssistantMessage(message))) return true;
  return findConcludingAssistantReply(messages) != null;
}

export function buildClearedActiveRunPatch(): Partial<ChatState> {
  return {
    sending: false,
    activeRunId: null,
    pendingFinal: false,
    streamingText: '',
    streamingMessage: null,
    streamingTools: [],
    pendingToolImages: [],
    lastUserMessageAt: null,
    runAborted: false,
    error: null,
    runError: null,
  };
}
