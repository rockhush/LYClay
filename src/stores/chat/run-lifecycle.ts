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

export function getAssistantStopReason(message: RawMessage): unknown {
  const msg = message as RawMessage & { stopReason?: unknown; stop_reason?: unknown };
  return msg.stopReason ?? msg.stop_reason;
}

/** Visible assistant reply with an explicit non-tool stop reason. */
export function isTerminalAssistantMessage(message: RawMessage | undefined): boolean {
  if (!message || message.role !== 'assistant') return false;
  if (!hasNonToolAssistantContent(message)) return false;
  return isExplicitAssistantStopReason(getAssistantStopReason(message));
}

/** Silent assistant reply (NO_REPLY / HEARTBEAT_OK) that closes the run. */
export function isSilentTerminalAssistantMessage(message: RawMessage | undefined): boolean {
  if (!message || message.role !== 'assistant') return false;
  if (!isInternalMessageText(getMessageText(message.content))) return false;
  return isExplicitAssistantStopReason(getAssistantStopReason(message));
}

export function isRunTerminalAssistantMessage(message: RawMessage | undefined): boolean {
  return isTerminalAssistantMessage(message) || isSilentTerminalAssistantMessage(message);
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
