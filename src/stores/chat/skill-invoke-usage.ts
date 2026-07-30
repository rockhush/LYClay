import { reportSkillInvoke } from '@/lib/usage-reporter';
import {
  buildFailedSkillInvokeReport,
  buildReadSkillInvokeReport,
} from '@/lib/skill-invoke-report';
import { resolveAgentDisplayName } from '@/lib/retired-digital-employees';
import {
  getActiveExecutionAuditContext,
  getActiveExecutionId,
} from '@/lib/execution-turn-tracker';
import { normalizeTimestampToMs } from '@/pages/Chat/message-utils';
import { useSkillsStore } from '@/stores/skills';
import { useAgentsStore } from '@/stores/agents';
import { useDigitalEmployeesStore } from '@/stores/digital-employees';
import type { RawMessage } from './types';
import { hasVisibleAssistantContent } from './helpers';
import {
  extractSkillInvocationFromToolCall,
  findAssistantMessageForToolCall,
  findToolCallInAssistantMessage,
  isSuccessfulToolResultMessage,
  isToolResultLikeRole,
  resolveToolCallIdFromToolResultMessage,
} from './usage-report-extract';
import { extractToolUse } from '@/pages/Chat/message-utils';
import type { ChatGet } from './store-api';

type SkillLike = { id?: string; slug?: string; name?: string };
type SkillInvokeMode = 'user_selected' | 'model_selected';

export type SkillInvokeTurnOutcome = {
  status: 'success' | 'failed' | 'cancelled';
  errorMessage?: string;
};

const DEFAULT_SKILL_INVOKE_TURN_OUTCOME: SkillInvokeTurnOutcome = { status: 'success' };

function resolveSkillInvokeReportErrorMessage(
  turnOutcome: SkillInvokeTurnOutcome,
  contextCached: boolean,
): string | undefined {
  if (turnOutcome.status === 'success') {
    return contextCached ? '调用上下文' : undefined;
  }
  return turnOutcome.errorMessage?.trim() || undefined;
}

type ObservedSkillRead = {
  skillId: string;
  skillPath?: string;
  invokeMode: SkillInvokeMode;
  invokeTimeMs: number;
  toolCallId: string;
};

type ActiveSkillInvokeTurn = {
  executionId: string;
  runId: string;
  agentId: string;
  sessionStartedAtMs: number | null;
  turnStartedAtMs: number;
  userSelectedSkillIds: string[];
  reads: Map<string, ObservedSkillRead>;
  finalized: boolean;
  /** Latest tool-result timestamp observed this turn (any tool, success or failure). */
  lastToolResultMs: number | null;
};

let activeTurn: ActiveSkillInvokeTurn | null = null;
const reportedSkillInvokeKeys = new Set<string>();
const REPORTED_SKILL_INVOKE_LIMIT = 2048;

function noteReportedSkillInvoke(key: string): boolean {
  if (reportedSkillInvokeKeys.has(key)) return false;
  reportedSkillInvokeKeys.add(key);
  if (reportedSkillInvokeKeys.size > REPORTED_SKILL_INVOKE_LIMIT) {
    const overflow = reportedSkillInvokeKeys.size - REPORTED_SKILL_INVOKE_LIMIT;
    let removed = 0;
    for (const value of reportedSkillInvokeKeys) {
      if (removed >= overflow) break;
      reportedSkillInvokeKeys.delete(value);
      removed += 1;
    }
  }
  return true;
}

function skillsReferToSame(left: string, right: string, skills: SkillLike[]): boolean {
  const leftSkill = skills.find((skill) =>
    skill.id === left || skill.slug === left || skill.name === left,
  );
  const rightSkill = skills.find((skill) =>
    skill.id === right || skill.slug === right || skill.name === right,
  );
  if (leftSkill && rightSkill) {
    if (leftSkill.id && rightSkill.id && leftSkill.id === rightSkill.id) return true;
    if (leftSkill.slug && rightSkill.slug && leftSkill.slug === rightSkill.slug) return true;
    if (leftSkill.name && rightSkill.name && leftSkill.name === rightSkill.name) return true;
  }
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function resolveReadInvokeTimeMs(
  assistantMessage: RawMessage | undefined,
  fallbackMs: number,
): number {
  const ms = normalizeTimestampToMs(assistantMessage?.timestamp);
  return ms ?? fallbackMs;
}

function collectTurnMessages(state: {
  messages: RawMessage[];
  streamingMessage?: RawMessage | null;
}): RawMessage[] {
  let userIdx = -1;
  for (let i = state.messages.length - 1; i >= 0; i -= 1) {
    if (state.messages[i].role === 'user') {
      userIdx = i;
      break;
    }
  }
  return userIdx >= 0 ? state.messages.slice(userIdx + 1) : [...state.messages];
}

function noteToolResultActivity(
  turn: ActiveSkillInvokeTurn,
  toolResultMessage: RawMessage,
): void {
  if (!isToolResultLikeRole(toolResultMessage.role)) return;
  const ts = normalizeTimestampToMs(toolResultMessage.timestamp);
  if (ts == null) return;
  if (turn.lastToolResultMs == null || ts > turn.lastToolResultMs) {
    turn.lastToolResultMs = ts;
  }
}

/** Skill execution end: last tool result after start, else first visible assistant, else fallback. */
function resolveSkillExecutionEndTimeMs(input: {
  turnMessages: RawMessage[];
  skillStartMs: number;
  trackedLastToolResultMs: number | null;
  terminalMessage?: RawMessage;
  fallbackMs: number;
}): number {
  const { turnMessages, skillStartMs, trackedLastToolResultMs, terminalMessage, fallbackMs } = input;
  const startCutoffMs = skillStartMs - 1000;

  let lastToolMs = trackedLastToolResultMs;
  if (lastToolMs != null && lastToolMs < startCutoffMs) {
    lastToolMs = null;
  }
  for (const message of turnMessages) {
    const ts = normalizeTimestampToMs(message.timestamp);
    if (ts != null && ts < startCutoffMs) continue;
    if (isToolResultLikeRole(message.role) && ts != null) {
      if (lastToolMs == null || ts > lastToolMs) lastToolMs = ts;
    }
  }
  if (terminalMessage) {
    const ts = normalizeTimestampToMs(terminalMessage.timestamp);
    if (ts != null && ts >= startCutoffMs && isToolResultLikeRole(terminalMessage.role)) {
      if (lastToolMs == null || ts > lastToolMs) lastToolMs = ts;
    }
  }
  if (lastToolMs != null) return lastToolMs;

  for (const message of turnMessages) {
    const ts = normalizeTimestampToMs(message.timestamp);
    if (ts != null && ts < startCutoffMs) continue;
    if (message.role === 'assistant' && hasVisibleAssistantContent(message)) {
      return ts ?? fallbackMs;
    }
  }
  if (
    terminalMessage?.role === 'assistant'
    && hasVisibleAssistantContent(terminalMessage)
  ) {
    const ts = normalizeTimestampToMs(terminalMessage.timestamp);
    if (ts == null || ts >= startCutoffMs) return ts ?? fallbackMs;
  }

  return fallbackMs;
}

function ensureActiveTurn(input: {
  executionId: string;
  runId?: string;
  agentId: string;
  sessionStartedAtMs: number | null;
  turnStartedAtMs: number;
}): ActiveSkillInvokeTurn {
  if (activeTurn && activeTurn.executionId === input.executionId && !activeTurn.finalized) {
    if (input.runId?.trim()) activeTurn.runId = input.runId.trim();
    return activeTurn;
  }
  activeTurn = {
    executionId: input.executionId,
    runId: (input.runId || '').trim(),
    agentId: input.agentId,
    sessionStartedAtMs: input.sessionStartedAtMs,
    turnStartedAtMs: input.turnStartedAtMs,
    userSelectedSkillIds: [],
    reads: new Map(),
    finalized: false,
    lastToolResultMs: null,
  };
  return activeTurn;
}

/** Start tracking skill reads for the current execution turn (even without user-selected skills). */
export function ensureSkillInvokeTurnTracking(input: {
  executionId: string;
  runId?: string;
  agentId: string;
  sessionStartedAtMs: number | null;
  turnStartedAtMs: number;
}): void {
  const executionId = (input.executionId || '').trim();
  if (!executionId) return;
  ensureActiveTurn(input);
}

function bootstrapActiveTurnForExecution(
  executionId: string,
  get: ChatGet,
  runId?: string,
): ActiveSkillInvokeTurn | null {
  const audit = getActiveExecutionAuditContext();
  if (activeTurn && activeTurn.executionId === executionId && activeTurn.finalized) {
    return null;
  }
  return ensureActiveTurn({
    executionId,
    runId,
    agentId: audit.agentId ?? get().currentAgentId ?? 'main',
    sessionStartedAtMs: audit.sessionStartedAtMs,
    turnStartedAtMs: audit.startedAtMs ?? Date.now(),
  });
}

export function registerPendingUserSelectedSkills(input: {
  executionId: string;
  runId?: string;
  agentId: string;
  skillIds: string[];
  sessionStartedAtMs: number | null;
  turnStartedAtMs: number;
}): void {
  const executionId = (input.executionId || '').trim();
  if (!executionId) return;
  const skills = useSkillsStore.getState().skills;
  const turn = ensureActiveTurn(input);
  for (const rawSkillId of input.skillIds) {
    const skillId = rawSkillId.trim();
    if (!skillId) continue;
    if (turn.userSelectedSkillIds.some((existing) => skillsReferToSame(existing, skillId, skills))) {
      continue;
    }
    turn.userSelectedSkillIds.push(skillId);
  }
}

function resolveSkillInvokeAgentId(rawAgentId: string): string {
  return resolveAgentDisplayName(rawAgentId, {
    agents: useAgentsStore.getState().agents,
    digitalEmployees: useDigitalEmployeesStore.getState().employees,
  });
}

function recordObservedSkillRead(input: {
  skillId: string;
  skillPath?: string;
  invokeMode: SkillInvokeMode;
  invokeTimeMs: number;
  toolCallId: string;
  runId: string;
}): void {
  const executionId = (getActiveExecutionId() || '').trim();
  if (!executionId) return;
  const audit = getActiveExecutionAuditContext();
  if (!activeTurn || activeTurn.executionId !== executionId || activeTurn.finalized) {
    if (activeTurn?.finalized) return;
    ensureActiveTurn({
      executionId,
      runId: input.runId,
      agentId: audit.agentId ?? 'main',
      sessionStartedAtMs: audit.sessionStartedAtMs,
      turnStartedAtMs: audit.startedAtMs ?? Date.now(),
    });
  }
  if (!activeTurn || activeTurn.executionId !== executionId || activeTurn.finalized) {
    return;
  }
  const skills = useSkillsStore.getState().skills;
  const isUserSelected = activeTurn.userSelectedSkillIds.some((pending) =>
    skillsReferToSame(pending, input.skillId, skills),
  );
  const readKey = `${executionId}::${input.skillId.toLowerCase()}`;
  if (activeTurn.reads.has(readKey)) return;
  activeTurn.reads.set(readKey, {
    skillId: input.skillId,
    skillPath: input.skillPath,
    invokeMode: isUserSelected ? 'user_selected' : input.invokeMode,
    invokeTimeMs: input.invokeTimeMs,
    toolCallId: input.toolCallId,
  });
  if (input.runId.trim()) activeTurn.runId = input.runId.trim();
}

function observeReadFromAssistantMessage(
  message: RawMessage,
  runId: string,
): void {
  if (message.role !== 'assistant') return;
  const invokeTimeMs = resolveReadInvokeTimeMs(message, Date.now());
  for (const tool of extractToolUse(message)) {
    if ((tool.name || '').trim().toLowerCase() !== 'read') continue;
    const input = (tool.input && typeof tool.input === 'object' && !Array.isArray(tool.input))
      ? tool.input as Record<string, unknown>
      : {};
    const invocation = extractSkillInvocationFromToolCall(tool.name, input);
    if (!invocation) continue;
    recordObservedSkillRead({
      skillId: invocation.skillId,
      skillPath: invocation.skillPath,
      invokeMode: 'model_selected',
      invokeTimeMs,
      toolCallId: tool.id || `read-${invocation.skillId}`,
      runId,
    });
  }
}

function observeReadFromToolResult(
  toolResultMessage: RawMessage,
  runId: string,
  get: ChatGet,
): void {
  const executionId = (getActiveExecutionId() || '').trim();
  if (!executionId || !activeTurn || activeTurn.executionId !== executionId || activeTurn.finalized) {
    return;
  }
  if (!isSuccessfulToolResultMessage(toolResultMessage)) return;

  const toolCallId = resolveToolCallIdFromToolResultMessage(toolResultMessage);
  if (!toolCallId) return;
  const dedupeKey = `${executionId}::read::${toolCallId}`;
  if (reportedSkillInvokeKeys.has(dedupeKey)) return;

  const state = get();
  const assistantMessage = findAssistantMessageForToolCall(
    state.messages,
    state.streamingMessage as RawMessage | null,
    toolCallId,
  );
  const toolCall = findToolCallInAssistantMessage(assistantMessage, toolCallId);
  if (!toolCall) return;

  const invocation = extractSkillInvocationFromToolCall(toolCall.name, toolCall.input);
  if (!invocation) return;

  recordObservedSkillRead({
    skillId: invocation.skillId,
    skillPath: invocation.skillPath,
    invokeMode: activeTurn.userSelectedSkillIds.some((pending) =>
      skillsReferToSame(pending, invocation.skillId, useSkillsStore.getState().skills),
    ) ? 'user_selected' : 'model_selected',
    invokeTimeMs: resolveReadInvokeTimeMs(assistantMessage ?? undefined, Date.now()),
    toolCallId,
    runId,
  });
}

export function reportUsageFromToolResult(
  _assistantMessage: RawMessage | undefined,
  toolResultMessage: RawMessage | undefined,
  runId: string,
  get: ChatGet,
): void {
  if (!toolResultMessage) return;
  const executionId = (getActiveExecutionId() || '').trim();
  if (executionId && activeTurn && activeTurn.executionId === executionId && !activeTurn.finalized) {
    noteToolResultActivity(activeTurn, toolResultMessage);
  }
  observeReadFromToolResult(toolResultMessage, runId, get);
}

export function scanTurnForUnreportedSkillInvokes(get: ChatGet, runId: string): void {
  const state = get();
  const turnMessages = collectTurnMessages(state);
  for (const message of turnMessages) {
    if (message.role === 'assistant') {
      observeReadFromAssistantMessage(message, runId);
      continue;
    }
    if (!isToolResultLikeRole(message.role)) continue;
    if (activeTurn && !activeTurn.finalized) {
      noteToolResultActivity(activeTurn, message);
    }
    observeReadFromToolResult(message, runId, get);
  }
}

function queueSkillInvokeReport(
  executionId: string,
  payload: Parameters<typeof reportSkillInvoke>[0],
): void {
  const skillId = typeof payload === 'string' ? payload : payload.skillId;
  const reportKey = `${executionId}::${skillId.trim().toLowerCase()}`;
  if (!noteReportedSkillInvoke(reportKey)) return;
  void reportSkillInvoke(payload);
}

export function finalizeSkillInvokeReports(
  get: ChatGet,
  runId: string,
  terminalMessage?: RawMessage,
  endMs = Date.now(),
  turnOutcome: SkillInvokeTurnOutcome = DEFAULT_SKILL_INVOKE_TURN_OUTCOME,
): void {
  const audit = getActiveExecutionAuditContext();
  const executionId = (audit.executionId || getActiveExecutionId() || '').trim();
  if (!executionId) return;

  bootstrapActiveTurnForExecution(executionId, get, runId);
  if (!activeTurn || activeTurn.executionId !== executionId || activeTurn.finalized) {
    return;
  }

  scanTurnForUnreportedSkillInvokes(get, runId);
  activeTurn.finalized = true;

  const state = get();
  const turnMessages = collectTurnMessages(state);
  const skills = useSkillsStore.getState().skills;
  const agentId = resolveSkillInvokeAgentId(
    audit.agentId ?? get().currentAgentId ?? activeTurn.agentId ?? 'main',
  );
  const reportedSkillIds = new Set<string>();

  const resolveEndForSkill = (skillStartMs: number): number => resolveSkillExecutionEndTimeMs({
    turnMessages,
    skillStartMs,
    trackedLastToolResultMs: activeTurn!.lastToolResultMs,
    terminalMessage,
    fallbackMs: endMs,
  });

  for (const pendingSkillId of activeTurn.userSelectedSkillIds) {
    const read = [...activeTurn.reads.values()].find((entry) =>
      skillsReferToSame(entry.skillId, pendingSkillId, skills),
    );
    const canonicalSkillId = read?.skillId ?? pendingSkillId;
    const canonicalKey = canonicalSkillId.trim().toLowerCase();
    if (reportedSkillIds.has(canonicalKey)) continue;
    reportedSkillIds.add(canonicalKey);

    const skillStartMs = read?.invokeTimeMs ?? activeTurn.turnStartedAtMs;
    const invokeEndTimeMs = resolveEndForSkill(skillStartMs);

    if (read) {
      queueSkillInvokeReport(executionId, buildReadSkillInvokeReport({
        skillId: canonicalSkillId,
        skills,
        skillPath: read?.skillPath,
        executionId,
        agentId,
        sessionStartedAtMs: activeTurn.sessionStartedAtMs,
        invokeMode: 'user_selected',
        invokeTimeMs: read.invokeTimeMs,
        invokeEndTimeMs,
        status: turnOutcome.status,
        errorMessage: resolveSkillInvokeReportErrorMessage(turnOutcome, false),
      }));
    } else {
      queueSkillInvokeReport(executionId, buildFailedSkillInvokeReport({
        skillId: pendingSkillId,
        skills,
        executionId,
        agentId,
        sessionStartedAtMs: activeTurn.sessionStartedAtMs,
        invokeMode: 'user_selected',
        invokeTimeMs: activeTurn.turnStartedAtMs,
        invokeEndTimeMs,
        status: turnOutcome.status,
        errorMessage: resolveSkillInvokeReportErrorMessage(turnOutcome, true),
      }));
    }
  }

  for (const read of activeTurn.reads.values()) {
    const canonicalKey = read.skillId.trim().toLowerCase();
    if (read.invokeMode !== 'model_selected' || reportedSkillIds.has(canonicalKey)) continue;
    reportedSkillIds.add(canonicalKey);
    queueSkillInvokeReport(executionId, buildReadSkillInvokeReport({
      skillId: read.skillId,
      skills,
      skillPath: read.skillPath,
      executionId,
      agentId,
      sessionStartedAtMs: activeTurn.sessionStartedAtMs,
      invokeMode: 'model_selected',
      invokeTimeMs: read.invokeTimeMs,
      invokeEndTimeMs: resolveEndForSkill(read.invokeTimeMs),
      status: turnOutcome.status,
      errorMessage: resolveSkillInvokeReportErrorMessage(turnOutcome, false),
    }));
  }

  activeTurn = null;
}

export function resetSkillInvokeTurnTracking(): void {
  activeTurn = null;
  reportedSkillInvokeKeys.clear();
}
