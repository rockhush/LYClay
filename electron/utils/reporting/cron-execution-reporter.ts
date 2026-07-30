/**
 * Report scheduled-task (cron) executions from the main process when Gateway
 * runs initiated by cron-supervisor reach a terminal state.
 *
 * Renderer `beginExecutionTurn` is bypassed for supervisor-fired chat.send runs;
 * this module closes that gap with transcript-backed token/model fields.
 */

import { randomUUID } from 'node:crypto';
import { listAgentsSnapshot } from '../agent-config';
import { logger } from '../logger';
import {
  clampExecutionFirstResponseMs,
  resolveExecutionReportModelId,
} from '../../../shared/reporting/execution-report-fields';
import { formatReportDateTime } from './time';
import {
  getCronExecutionPending,
  isCronExecutionReported,
  markCronExecutionReported,
  takeCronExecutionPending,
} from './cron-execution-pending';
import {
  loadUsageEntriesForSessionKey,
  pickBestUsageEntry,
  readSessionTranscriptContent,
} from './execution-transcript-enrich';
import { getUsageReportQueueSnapshot } from './queue';
import { recordExecution } from './index';
import { reportCronSkillInvokesFromTranscript } from './cron-skill-invoke-reporter';
import type { ExecutionRecord } from './types';

const TURN_MATCH_TOLERANCE_MS = 2 * 60 * 1000;
const TRANSCRIPT_READ_ATTEMPTS = 4;
const TRANSCRIPT_READ_DELAY_MS = 250;

type TerminalState = 'final' | 'error' | 'aborted';

type TranscriptUserTurn = {
  turnIndex: number;
  timestampMs: number;
};

function parseTranscriptMessageTimestamp(message: unknown, entryTimestamp?: unknown): number | undefined {
  if (message && typeof message === 'object') {
    const timestamp = (message as { timestamp?: unknown }).timestamp;
    if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
      return timestamp < 1e12 ? timestamp * 1000 : timestamp;
    }
    if (typeof timestamp === 'string' && timestamp.trim()) {
      const parsed = Date.parse(timestamp);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  if (typeof entryTimestamp === 'string' && entryTimestamp.trim()) {
    const parsed = Date.parse(entryTimestamp.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function parseUserTurnsFromTranscript(content: string): TranscriptUserTurn[] {
  const turns: TranscriptUserTurn[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as {
        type?: string;
        timestamp?: string;
        message?: { role?: unknown };
      };
      if (entry.type !== 'message' || entry.message?.role !== 'user') continue;
      const timestampMs = parseTranscriptMessageTimestamp(entry.message, entry.timestamp);
      if (timestampMs == null) continue;
      turns.push({ turnIndex: turns.length + 1, timestampMs });
    } catch {
      // Ignore malformed transcript lines.
    }
  }
  return turns;
}

function matchTurnForAcceptedAt(turns: TranscriptUserTurn[], acceptedAtMs: number): TranscriptUserTurn | null {
  if (turns.length === 0) return null;

  let best = turns[0]!;
  let bestDelta = Math.abs(best.timestampMs - acceptedAtMs);
  for (const turn of turns) {
    const delta = Math.abs(turn.timestampMs - acceptedAtMs);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = turn;
    }
  }

  if (bestDelta <= TURN_MATCH_TOLERANCE_MS) return best;
  return turns[turns.length - 1] ?? null;
}

function resolveAgentType(agentId: string): ExecutionRecord['agent_type'] {
  return agentId.startsWith('employee-') ? 'digital_employee' : 'normal';
}

function mapTerminalStatus(state: TerminalState): ExecutionRecord['status'] {
  if (state === 'final') return 'success';
  if (state === 'aborted') return 'cancelled';
  return 'failed';
}

function classifyExecutionErrorStage(
  errorMessage: string | null | undefined,
  options?: { cancelled?: boolean },
): ExecutionRecord['error_stage'] {
  if (options?.cancelled) return 'client';
  const text = (errorMessage ?? '').trim();
  if (!text) return 'client';
  const lower = text.toLowerCase();
  if (/model|provider|api key|authentication|unauthorized|rate limit|429\b|quota|context length|openai|anthropic|bedrock/.test(lower)) {
    return 'model';
  }
  if (/gateway|websocket|\bws\b|connect|timeout|timed out|unreachable|econnrefused|enetunreach|network|127\.0\.0\.1:18789|session\.abort/.test(lower)) {
    return 'gateway';
  }
  return 'client';
}

function getMessageText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const record = message as Record<string, unknown>;
  const direct = record.content ?? record.text ?? record.message;
  if (typeof direct === 'string') return direct.trim();
  if (!Array.isArray(direct)) return '';
  return direct.map((block) => {
    if (!block || typeof block !== 'object') return '';
    const item = block as Record<string, unknown>;
    if (typeof item.text === 'string') return item.text;
    if (typeof item.content === 'string') return item.content;
    return '';
  }).filter(Boolean).join('\n').trim();
}

function resolveFirstResponseMs(
  turnStartedAtMs: number,
  firstVisibleProgressAt?: number,
  firstDeltaAt?: number,
): number | undefined {
  const anchor = firstVisibleProgressAt ?? firstDeltaAt;
  if (anchor == null || !Number.isFinite(anchor)) return undefined;
  return Math.max(0, anchor - turnStartedAtMs);
}

async function resolveAgentModelRefFallback(agentId: string): Promise<string | undefined> {
  try {
    const snapshot = await listAgentsSnapshot();
    const agent = snapshot.agents.find((entry) => entry.id === agentId);
    return agent?.modelRef?.trim() || snapshot.defaultModelRef?.trim() || undefined;
  } catch (error) {
    logger.debug('[UsageReport] cron execution: failed to resolve agent model fallback', {
      agentId,
      error: String(error),
    });
    return undefined;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function readTranscriptWithRetry(sessionKey: string): Promise<string | null> {
  for (let attempt = 0; attempt < TRANSCRIPT_READ_ATTEMPTS; attempt += 1) {
    const content = await readSessionTranscriptContent(sessionKey);
    if (content?.trim()) return content;
    if (attempt < TRANSCRIPT_READ_ATTEMPTS - 1) {
      await sleep(TRANSCRIPT_READ_DELAY_MS);
    }
  }
  return null;
}

async function hasQueuedScheduleExecution(
  conversationId: string,
  turnIndex: number,
): Promise<boolean> {
  const snapshot = await getUsageReportQueueSnapshot();
  return snapshot.execution.some((record) =>
    record.conversation_id === conversationId
    && record.entry_source === 'schedule'
    && record.turn_index === turnIndex);
}

export async function reportCronExecutionOnRunTerminal(args: {
  runId: string;
  sessionKey?: string;
  state: TerminalState;
  acceptedAtMs?: number;
  firstVisibleProgressAt?: number;
  firstDeltaAt?: number;
  terminalMessage?: unknown;
}): Promise<void> {
  if (isCronExecutionReported(args.runId)) return;

  const pending = getCronExecutionPending(args.runId);
  if (!pending) return;

  const resolvedSessionKey = (args.sessionKey ?? pending.sessionKey).trim();
  if (resolvedSessionKey !== pending.sessionKey) {
    logger.debug('[UsageReport] cron execution: sessionKey mismatch, skipping', {
      runId: args.runId,
      expected: pending.sessionKey,
      actual: args.sessionKey,
    });
    return;
  }

  takeCronExecutionPending(args.runId);

  const acceptedAtMs = args.acceptedAtMs ?? pending.registeredAtMs;
  const endedAtMs = Date.now();
  const status = mapTerminalStatus(args.state);
  const errorMessage = status === 'failed' || status === 'cancelled'
    ? getMessageText(args.terminalMessage).slice(0, 1024) || undefined
    : undefined;
  const errorStage = status === 'failed' || status === 'cancelled'
    ? classifyExecutionErrorStage(errorMessage, { cancelled: status === 'cancelled' })
    : undefined;

  const transcript = await readTranscriptWithRetry(resolvedSessionKey);
  const userTurns = transcript ? parseUserTurnsFromTranscript(transcript) : [];
  const matchedTurn = matchTurnForAcceptedAt(userTurns, acceptedAtMs);
  const turnIndex = matchedTurn?.turnIndex ?? Math.max(1, userTurns.length);

  if (await hasQueuedScheduleExecution(resolvedSessionKey, turnIndex)) {
    logger.info('[UsageReport] cron execution: duplicate schedule turn skipped', {
      runId: args.runId,
      sessionKey: resolvedSessionKey,
      turnIndex,
    });
    markCronExecutionReported(args.runId);
    return;
  }

  const startedAtMs = matchedTurn?.timestampMs ?? acceptedAtMs;
  const sessionStartedAtMs = userTurns[0]?.timestampMs ?? startedAtMs;

  const usageEntries = await loadUsageEntriesForSessionKey(resolvedSessionKey);
  const usageMatch = pickBestUsageEntry(usageEntries, startedAtMs, endedAtMs);
  const modelFallback = await resolveAgentModelRefFallback(pending.agentId);
  const modelId = resolveExecutionReportModelId(
    usageMatch?.model,
    usageMatch?.provider,
    modelFallback,
  );
  const firstResponseMs = clampExecutionFirstResponseMs(
    resolveFirstResponseMs(
      startedAtMs,
      args.firstVisibleProgressAt,
      args.firstDeltaAt,
    ),
    startedAtMs,
    endedAtMs,
  );

  const executionId = randomUUID();

  await recordExecution({
    execution_id: executionId,
    conversation_id: resolvedSessionKey,
    turn_index: turnIndex,
    entry_source: 'schedule',
    agent_type: resolveAgentType(pending.agentId),
    agent_id: pending.agentId,
    model_id: modelId,
    status,
    started_at: formatReportDateTime(startedAtMs),
    ended_at: formatReportDateTime(endedAtMs),
    create_date: formatReportDateTime(sessionStartedAtMs),
    update_date: formatReportDateTime(startedAtMs),
    ...(firstResponseMs != null ? { first_response_ms: firstResponseMs } : {}),
    ...(usageMatch ? {
      input_tokens: usageMatch.inputTokens,
      output_tokens: usageMatch.outputTokens,
      cache_read_tokens: usageMatch.cacheReadTokens,
    } : {}),
    ...(errorStage ? { error_stage: errorStage } : {}),
    ...(errorMessage ? { error_message: errorMessage } : {}),
  });

  if (transcript?.trim()) {
    await reportCronSkillInvokesFromTranscript({
      transcript,
      executionId,
      agentId: pending.agentId,
      sessionStartedAtMs,
      turnStartedAtMs: startedAtMs,
      turnEndedAtMs: endedAtMs,
      executionStatus: status,
    });
  }

  markCronExecutionReported(args.runId);

  logger.info('[UsageReport] cron execution queued', {
    runId: args.runId,
    sessionKey: resolvedSessionKey,
    turnIndex,
    status,
    modelId,
  });
}
