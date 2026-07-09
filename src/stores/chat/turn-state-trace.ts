import { appendRendererLog } from '@/lib/api-client';
import { getMessageText } from './helpers';
import type { RawMessage, ToolStatus } from './types';

const LOG_PREFIX = '[chat.turn-state]';

type TracePayload = Record<string, unknown>;

type TraceUiSignals = {
  sending: boolean;
  activeRunId: string | null;
  pendingFinal: boolean;
  runAborted?: boolean;
  aborting?: boolean;
};

type TraceBackendActivity = {
  sessionKey: string;
  status: string | null;
  processing: boolean;
  hasTrackedUserRun: boolean;
  activeRunIds: string[];
};

type TraceGatewayBackground = {
  hasBackgroundProcessing: boolean;
  processingSessionKeys: string[];
};

const _lastDecisionSignatureByKey = new Map<string, string>();

function safePreview(text: string, max = 120): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

export function summarizeUiSignals(state: TraceUiSignals): TracePayload {
  return {
    sending: state.sending,
    pendingFinal: state.pendingFinal,
    activeRunId: state.activeRunId ?? null,
    runAborted: state.runAborted ?? false,
    aborting: state.aborting ?? false,
  };
}

export function summarizeBackendActivity(
  activity: TraceBackendActivity | null | undefined,
): TracePayload | null {
  if (!activity) return null;
  return {
    sessionKey: activity.sessionKey,
    status: activity.status,
    processing: activity.processing,
    hasTrackedUserRun: activity.hasTrackedUserRun,
    activeRunIds: activity.activeRunIds,
  };
}

export function summarizeGatewayBackground(
  background: TraceGatewayBackground | null | undefined,
): TracePayload | null {
  if (!background) return null;
  return {
    hasBackgroundProcessing: background.hasBackgroundProcessing,
    processingSessionKeys: background.processingSessionKeys,
  };
}

export function summarizeStreamingTools(tools: readonly ToolStatus[]): TracePayload {
  return {
    count: tools.length,
    running: tools.filter((t) => t.status === 'running').map((t) => t.name || t.id || 'tool'),
    completed: tools.filter((t) => t.status === 'completed').map((t) => t.name || t.id || 'tool'),
    error: tools.filter((t) => t.status === 'error').map((t) => t.name || t.id || 'tool'),
  };
}

export function summarizeAssistantMessage(message: RawMessage | undefined | null): TracePayload | null {
  if (!message) return null;
  const text = safePreview(getMessageText(message.content));
  const stopReason = (message as { stopReason?: string; stop_reason?: string }).stopReason
    ?? (message as { stop_reason?: string }).stop_reason
    ?? null;
  let toolUseCount = 0;
  let thinkingBlocks = 0;
  if (Array.isArray(message.content)) {
    for (const block of message.content as Array<{ type?: string }>) {
      if (block.type === 'tool_use' || block.type === 'toolCall') toolUseCount += 1;
      if (block.type === 'thinking') thinkingBlocks += 1;
    }
  }
  return {
    id: message.id ?? null,
    role: message.role,
    stopReason,
    textPreview: text || null,
    toolUseCount,
    thinkingBlocks,
    timestamp: message.timestamp ?? null,
  };
}

export function summarizeTranscriptTail(
  messages: readonly RawMessage[],
  lastUserMessageAt: number | null,
  take = 4,
): TracePayload {
  const tail = messages.slice(-take);
  return {
    messageCount: messages.length,
    lastUserMessageAt,
    tail: tail.map((message, index) => ({
      offset: messages.length - tail.length + index,
      role: message.role,
      id: message.id ?? null,
      textPreview: safePreview(getMessageText(message.content), 80) || null,
      stopReason: (message as { stopReason?: string }).stopReason ?? null,
    })),
  };
}

function emitTurnStateTrace(event: string, details: TracePayload): void {
  const message = `${LOG_PREFIX} ${event}`;
  // DevTools in development; main-process LYClaw-*.log in packaged builds (INFO level).
  // eslint-disable-next-line no-console
  console.debug(message, details);
  appendRendererLog('info', message, details);
}

/** Always log a state-machine transition (runtime events, finalize, history, etc.). */
export function traceTurnTransition(
  event: string,
  details: TracePayload = {},
): void {
  emitTurnStateTrace(event, details);
}

/**
 * Log a derived decision only when its signature changes (avoids render-loop spam).
 * Pass `dedupeKey` to scope dedupe (e.g. per session).
 */
export function traceTurnDecision(
  event: string,
  decision: boolean | string,
  details: TracePayload = {},
  dedupeKey = 'global',
): void {
  const signature = `${event}|${String(decision)}|${JSON.stringify(details)}`;
  if (_lastDecisionSignatureByKey.get(dedupeKey) === signature) return;
  _lastDecisionSignatureByKey.set(dedupeKey, signature);
  traceTurnTransition(event, { decision, ...details });
}

export function resetTurnStateTraceForTests(): void {
  _lastDecisionSignatureByKey.clear();
}
