import { getMessageText, hasNonToolAssistantContent, isInternalMessageText } from './helpers';
import type { ChatState, RawMessage } from './types';

export function isExplicitAssistantStopReason(stopReason: unknown): boolean {
  if (stopReason == null) return false;
  const normalized = String(stopReason).toLowerCase();
  return normalized !== 'tooluse'
    && normalized !== 'tool_use'
    && normalized !== 'tool-call'
    && normalized !== 'tool_calls';
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
  if (!hasNonToolAssistantContent(message)) return false;
  return isExplicitAssistantStopReason(getAssistantStopReason(message));
}

/** Silent assistant reply (NO_REPLY / HEARTBEAT_OK) that closes the run. */
export function isSilentTerminalAssistantMessage(message: RawMessage | undefined): boolean {
  if (!message || message.role !== 'assistant') return false;
  if (isFailedAssistantMessage(message)) return false;
  if (!isInternalMessageText(getMessageText(message.content))) return false;
  return isExplicitAssistantStopReason(getAssistantStopReason(message));
}

export function isRunTerminalAssistantMessage(message: RawMessage | undefined): boolean {
  return isTerminalAssistantMessage(message) || isSilentTerminalAssistantMessage(message);
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
  };
}
