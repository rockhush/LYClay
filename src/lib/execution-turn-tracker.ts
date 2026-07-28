/**
 * Tracks one user turn (Enter → assistant reply) and queues execution stats.
 */

import { resolveMessageDisplayTimestamp, normalizeTimestampToMs } from '@/pages/Chat/message-utils';
import type { RawMessage } from '@/stores/chat/types';
import { isCronSessionKey } from '@/stores/chat/cron-session-utils';
import { reportExecution, type ExecutionReportInput } from '@/lib/usage-reporter';
import { classifyExecutionErrorStage } from '@/lib/execution-error-stage';
import { extractUsageTokensFromMessage } from '@/lib/token-usage-parse';
import {
  countVisibleUserTurns,
  findConcludingAssistantForActiveTurn,
} from '@/stores/chat/run-lifecycle';
import { hasVisibleAssistantContent, hasAssistantFirstResponseActivity } from '@/stores/chat/helpers';

type EntrySource = ExecutionReportInput['entry_source'];
type AgentType = ExecutionReportInput['agent_type'];
type ExecutionStatus = ExecutionReportInput['status'];

type ActiveExecutionTurn = {
  executionId: string;
  conversationId: string;
  agentId: string;
  modelId: string;
  turnIndex: number;
  entrySource: EntrySource;
  agentType: AgentType;
  startedAtMs: number;
  sessionStartedAtMs: number;
  firstTokenAtMs?: number;
};

let activeTurn: ActiveExecutionTurn | null = null;
const reportedExecutionIds = new Set<string>();

function formatReportDateTimeMs(ms: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(ms));
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}:${pick('second')}`;
}

function resolveEntrySource(sessionKey: string, agentType: AgentType): EntrySource {
  if (isCronSessionKey(sessionKey)) return 'schedule';
  if (agentType === 'digital_employee') return 'digital_employee';
  return 'chat';
}

function resolveAgentType(agentId: string, isDigitalEmployee?: boolean): AgentType {
  if (isDigitalEmployee || agentId.startsWith('employee-')) return 'digital_employee';
  return 'normal';
}

function resolveSessionWindowStartMs(
  messages: RawMessage[],
  sessionKey: string,
  fallbackMs: number,
): number {
  let earliest: number | null = null;
  for (const message of messages) {
    if (message.role !== 'user') continue;
    if (message.id === `local-${sessionKey}`) continue;
    const ms = normalizeTimestampToMs(message.timestamp);
    if (ms == null) continue;
    if (earliest == null || ms < earliest) earliest = ms;
  }
  return earliest ?? fallbackMs;
}

function extractUsageFromMessage(message: RawMessage | undefined): {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
} {
  const parsed = extractUsageTokensFromMessage(message);
  if (!parsed) return {};
  return {
    input_tokens: parsed.inputTokens,
    output_tokens: parsed.outputTokens,
    cache_read_tokens: parsed.cacheReadTokens,
  };
}

function resolveEndedAtMs(
  terminalMessage: RawMessage | undefined,
  messages: RawMessage[],
  lastUserMessageAt: number | null,
): number {
  if (terminalMessage) {
    const fromDisplay = normalizeTimestampToMs(resolveMessageDisplayTimestamp(terminalMessage));
    if (fromDisplay) return fromDisplay;
    const fromMessage = normalizeTimestampToMs(terminalMessage.timestamp);
    if (fromMessage) return fromMessage;
  }
  const concluding = findConcludingAssistantForActiveTurn(messages, lastUserMessageAt)
    ?? [...messages].reverse().find((message) => message.role === 'assistant' && hasVisibleAssistantContent(message));
  if (concluding) {
    const fromDisplay = normalizeTimestampToMs(resolveMessageDisplayTimestamp(concluding));
    if (fromDisplay) return fromDisplay;
    const fromMessage = normalizeTimestampToMs(concluding.timestamp);
    if (fromMessage) return fromMessage;
  }
  return Date.now();
}

function trimErrorMessage(value: string | null | undefined): string | undefined {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, 1024);
}

export function beginExecutionTurn(input: {
  sessionKey: string;
  agentId: string;
  modelId: string;
  messages: RawMessage[];
  startedAtMs?: number;
  isDigitalEmployee?: boolean;
}): void {
  const startedAtMs = input.startedAtMs ?? Date.now();
  const agentType = resolveAgentType(input.agentId, input.isDigitalEmployee);
  // Messages already include the optimistic user bubble for this send — count
  // visible user rounds only (no +1, no synthetic sidebar label placeholders).
  const turnIndex = Math.max(1, countVisibleUserTurns(input.messages, input.sessionKey));
  activeTurn = {
    executionId: crypto.randomUUID(),
    conversationId: input.sessionKey,
    agentId: input.agentId,
    modelId: input.modelId.trim() || 'unknown',
    turnIndex,
    entrySource: resolveEntrySource(input.sessionKey, agentType),
    agentType,
    startedAtMs,
    sessionStartedAtMs: resolveSessionWindowStartMs(input.messages, input.sessionKey, startedAtMs),
  };
}

export function maybeMarkExecutionFirstToken(nowMs = Date.now()): void {
  // First model output: thinking, tool call, or assistant text (see hasAssistantFirstResponseActivity).
  if (!activeTurn || activeTurn.firstTokenAtMs) return;
  activeTurn.firstTokenAtMs = nowMs;
}

/**
 * Record first model output from a persisted/history message (transcript mirror path).
 * Uses the message timestamp when it falls inside the current turn window.
 */
export function noteExecutionFirstResponseFromMessage(message: RawMessage | null | undefined): void {
  if (!message || !activeTurn || activeTurn.firstTokenAtMs) return;
  if (!hasAssistantFirstResponseActivity(message)) return;

  const ts = normalizeTimestampToMs(message.timestamp);
  let markAt = Date.now();
  if (ts != null) {
    // Transcript lines are written when the segment lands — often earlier than WS deltas.
    if (ts >= activeTurn.startedAtMs - 2_000 && ts <= Date.now() + 2_000) {
      markAt = Math.max(ts, activeTurn.startedAtMs);
    }
  }
  maybeMarkExecutionFirstToken(markAt);
}

function resolveFirstResponseMs(
  turn: ActiveExecutionTurn,
  messages: RawMessage[],
  lastUserMessageAt: number | null,
): number | undefined {
  const fromDelta = turn.firstTokenAtMs != null
    ? Math.max(0, turn.firstTokenAtMs - turn.startedAtMs)
    : null;

  const turnStartMs = lastUserMessageAt ?? turn.startedAtMs;
  let fromMessages: number | null = null;
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    const ts = normalizeTimestampToMs(message.timestamp);
    if (ts != null && ts < turnStartMs - 1_000) continue;
    if (!hasAssistantFirstResponseActivity(message)) continue;
    const candidate = ts != null
      ? Math.max(0, ts - turn.startedAtMs)
      : null;
    if (candidate == null) continue;
    if (fromMessages == null || candidate < fromMessages) {
      fromMessages = candidate;
    }
  }

  if (fromDelta != null && fromMessages != null) return Math.min(fromDelta, fromMessages);
  return fromDelta ?? fromMessages ?? undefined;
}

export function getActiveExecutionId(): string | null {
  return activeTurn?.executionId ?? null;
}

export function getActiveExecutionAuditContext(): {
  executionId: string | null;
  agentId: string | null;
  sessionStartedAtMs: number | null;
  startedAtMs: number | null;
} {
  if (!activeTurn) {
    return {
      executionId: null,
      agentId: null,
      sessionStartedAtMs: null,
      startedAtMs: null,
    };
  }
  return {
    executionId: activeTurn.executionId,
    agentId: activeTurn.agentId,
    sessionStartedAtMs: activeTurn.sessionStartedAtMs,
    startedAtMs: activeTurn.startedAtMs,
  };
}

export function cancelExecutionTurnTracking(): void {
  activeTurn = null;
}

export function finalizeExecutionTurn(input: {
  status: ExecutionStatus;
  messages: RawMessage[];
  lastUserMessageAt: number | null;
  terminalMessage?: RawMessage;
  errorMessage?: string | null;
  errorStage?: ExecutionReportInput['error_stage'];
}): void {
  const turn = activeTurn;
  activeTurn = null;
  if (!turn) return;
  if (reportedExecutionIds.has(turn.executionId)) return;
  reportedExecutionIds.add(turn.executionId);
  if (reportedExecutionIds.size > 2_000) {
    reportedExecutionIds.clear();
    reportedExecutionIds.add(turn.executionId);
  }

  const terminal = input.terminalMessage
    ?? findConcludingAssistantForActiveTurn(input.messages, input.lastUserMessageAt);
  const usage = extractUsageFromMessage(terminal);
  const endedAtMs = resolveEndedAtMs(terminal, input.messages, input.lastUserMessageAt);
  const firstResponseMs = resolveFirstResponseMs(turn, input.messages, input.lastUserMessageAt);
  const errorMessage = trimErrorMessage(input.errorMessage);
  const errorStage = input.status === 'failed' || input.status === 'cancelled'
    ? (input.errorStage ?? classifyExecutionErrorStage(errorMessage, { cancelled: input.status === 'cancelled' }))
    : undefined;

  const record: ExecutionReportInput = {
    execution_id: turn.executionId,
    conversation_id: turn.conversationId,
    turn_index: turn.turnIndex,
    entry_source: turn.entrySource,
    agent_type: turn.agentType,
    agent_id: turn.agentId,
    model_id: turn.modelId,
    status: input.status,
    started_at: formatReportDateTimeMs(turn.startedAtMs),
    ended_at: formatReportDateTimeMs(endedAtMs),
    create_date: formatReportDateTimeMs(turn.sessionStartedAtMs),
    update_date: formatReportDateTimeMs(turn.startedAtMs),
    ...(firstResponseMs != null ? { first_response_ms: firstResponseMs } : {}),
    ...usage,
    ...(errorStage ? { error_stage: errorStage } : {}),
    ...(errorMessage ? { error_message: errorMessage } : {}),
  };

  void reportExecution(record).catch(() => {
    // Non-fatal telemetry — mirror other usage reporters.
  });
}
