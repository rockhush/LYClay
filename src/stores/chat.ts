/**
 * Chat State Store
 * Manages chat messages, sessions, and streaming state.
 * Communicates with OpenClaw Gateway via renderer WebSocket RPC.
 */
import { create } from 'zustand';
import i18n from '@/i18n';
import { getEmptyFinalDiagnostic, hostApiFetch, recoverStaleSessionAfterEmptyFinal } from '@/lib/host-api';
import { toUserMessage, normalizeAppError } from '@/lib/api-client';
import { useGatewayStore } from './gateway';
import { useAgentsStore } from './agents';
import { useWorkspacesStore } from './workspaces';
import { buildCronSessionHistoryPath, isCronSessionKey, mergeCronSessionHistory } from './chat/cron-session-utils';
import { collectAgentIdsFromSessionKeys, isPlaceholderSessionTitle } from '@/lib/session-label-utils';
import {
  CHAT_HISTORY_STARTUP_RETRY_DELAYS_MS,
  classifyHistoryStartupRetryError,
  getHistoryLoadingSafetyTimeout,
  getStartupHistoryTimeoutOverride,
  shouldRetryStartupHistoryLoad,
  sleep,
} from './chat/history-startup-retry';
import {
  DEFAULT_CANONICAL_PREFIX,
  DEFAULT_SESSION_KEY,
  type AttachedFileMeta,
  type ChatSession,
  type ChatState,
  type CompressionStateEntry,
  type ContentBlock,
  type ReasoningMode,
  type RawMessage,
  type RunawayToolObservation,
  type SessionStreamingState,
  type ToolStatus,
} from './chat/types';
import {
  attachmentFileNameFromPath,
  filterChannelOutboundEchoMessages,
  hasVisibleAssistantContent,
  isChannelDeliveryConfirmationText,
  isSuppressedRunError,
  shouldSuppressPartialSuccessRunError,
  isAbortErrorMessage,
  isRecoverableRuntimeError,
  isFatalRuntimeError,
  markUserAbort,
  resolveRunFailureErrorMessage,
  shouldTreatAbortAsUserStop,
  truncateRunErrorMessage,
  isWithinUserAbortWindow,
  shouldSuppressAssistantStreamingText,
  dedupeEquivalentAttachmentUserMessages,
  matchesOptimisticUserMessage,
  getLatestOptimisticUserMessage,
  normalizeComparableUserText,
  areEquivalentAttachmentOnlyUserTexts,
  stripGatewayUserMetadata,
} from './chat/helpers';
import {
  buildClearedActiveRunPatch,
  findConcludingAssistantForActiveTurn,
  findLatestVisibleUserIndex,
  findTerminalAssistantAfterLatestUser,
  findTerminalAssistantForActiveTurn,
  isConcludingAssistantReply,
  isFailedAssistantMessage,
  isRunTerminalAssistantMessage,
  shouldKeepRunActiveAfterAssistantFinal,
  shouldSilentlyFinalizeRunOnAssistantFinal,
} from './chat/run-lifecycle';
import {
  backendActivityForSession,
  canClearUserTurnNow,
  canForceClearOnVisibleCommittedReply,
  shouldFinalizeUserTurn,
  shouldForceAbortStuckRun,
  buildReAdoptRunPatch,
  hasOpenDelegatedBackendWork,
  sanitizeLeavingSessionStreamingSnapshot,
} from './chat/user-turn-lifecycle';
import {
  deferClearUserTurnForOpenDelegation,
  tryFinalizeUserTurnAfterAssistantFinal,
  clearFinalizeGraceTimer,
  getFinalizeGraceStartedAt,
  scheduleDelegationFinalizeGraceIfNeeded,
} from './chat/finalize-turn-bridge';
import {
  clearSessionActivityPoll,
  ensureSessionBackendPolling,
  refreshSessionBackendActivity,
  startSessionActivityPoll,
} from './chat/session-backend-bridge';
import {
  clearUserAbortedSession,
  isUserAbortedSession,
  persistUserAbortedSession,
} from './chat/user-aborted-sessions';
import { abortPendingChildDelegations } from './chat/abort-child-delegations';
import {
  isSubagentDelegationAnnounceRun,
  parseChildSessionKeyFromAnnounceRun,
} from '@/lib/subagent-delegation';
import { prepareContextBeforeSend } from './chat/context-send-guard';
import { applyTimeDecayStrategy, filterLargeToolResults } from './chat/history-time-decay';
import {
  bindRunIdToObservation,
  createRunawayToolObservation,
  detectTaskWorkflowKind,
  observeRunawayToolEvent,
} from './chat/runaway-tool-observer';
import {
  buildInitialConvergenceSystemPrompt,
  shouldUpgradeConvergenceDirective,
} from './chat/task-convergence-strategy';
import { scheduleUiStateSync } from '@/lib/ui-state-persistence';
import { mergeDiscoveredSessionActivity, resolveSessionListActivityMs } from '@/lib/session-sidebar-order';
import {
  isSubagentSessionKey,
  filterUserFacingSessions,
  pickUserFacingSession,
} from '@/lib/session-key-utils';
import { isEmptyChatScratchpad } from '@/lib/chat-scratchpad';

export type {
  AttachedFileMeta,
  ChatSession,
  ContentBlock,
  ReasoningMode,
  RawMessage,
  ToolStatus,
} from './chat/types';

/**
 * Reconstruct a compressed message view from cached compression state.
 * When a session was previously compressed, this replaces the older messages
 * with the summary, keeping only the recent messages that were retained.
 */
function reconstructCompressedView(
  messages: RawMessage[],
  state: CompressionStateEntry,
): RawMessage[] {
  const currentTotal = messages.length;
  const keepCount = state.totalMessagesAtCompression - state.compressedCount;

  // The "keep" messages are the last `keepCount` from the original set.
  // If new messages were added since compression, they appear after.
  const keepStart = Math.max(0, currentTotal - keepCount);
  let keptMessages = messages.slice(keepStart);

  // Filter large tool results (Layer 2) on kept messages
  keptMessages = filterLargeToolResults(keptMessages);

  const summaryMsg: RawMessage = {
    role: 'system',
    content: state.summaryText,
    timestamp: state.compressedAt / 1000,
    id: crypto.randomUUID(),
  };

  return [summaryMsg, ...keptMessages];
}

// Module-level timestamp tracking the last chat event received.
// Used by the safety timeout to avoid false-positive "no response" errors
// during tool-use conversations where streamingMessage is temporarily cleared
// between tool-result finals and the next delta.
let _lastChatEventAt = 0;

// Track if this is the first message sent since app/gateway startup
// Used to show "first-time initialization" warning
let _isFirstMessageEver = true;

export function resetFirstMessageFlag(): void {
  _isFirstMessageEver = true;
}

export function isFirstMessageEver(): boolean {
  return _isFirstMessageEver;
}

export function markFirstMessageSent(): void {
  _isFirstMessageEver = false;
}

/** Normalize a timestamp to milliseconds. Handles both seconds and ms. */
function toMs(ts: number): number {
  // Timestamps < 1e12 are in seconds (before ~2033); >= 1e12 are milliseconds
  return ts < 1e12 ? ts * 1000 : ts;
}

// Timer for fallback history polling during active sends.
// If no streaming events arrive within a few seconds, we periodically
// poll chat.history to surface intermediate tool-call turns.
let _historyPollTimer: ReturnType<typeof setTimeout> | null = null;

// Runs the user explicitly stopped ??ignore late gateway deltas after abort clears activeRunId.
const _abortedChatRunIds = new Set<string>();

// Timestamp of the most recent user-initiated stop. Late abort-type error
// events (which may arrive after the run id was already forgotten and
// runAborted reset) are suppressed when they land within this window.
// See markUserAbort / isWithinUserAbortWindow in ./chat/helpers.

function markAbortedChatRun(runId: string): void {
  const id = runId.trim();
  if (id) _abortedChatRunIds.add(id);
}

function isAbortedChatRun(runId: string): boolean {
  return _abortedChatRunIds.has(runId.trim());
}

function forgetAbortedChatRun(runId: string): void {
  _abortedChatRunIds.delete(runId.trim());
}

function clearAbortedChatRuns(): void {
  _abortedChatRunIds.clear();
}

// Timer for delayed error finalization. When the Gateway reports a mid-stream
// error (e.g. "terminated"), it may retry internally and recover. We wait
// before committing the error to give the recovery path a chance.
let _errorRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
let _thinkingLevelPatchTimer: ReturnType<typeof setTimeout> | null = null;
let _sessionModelPatchTimer: ReturnType<typeof setTimeout> | null = null;
const _pendingThinkingLevelPatches = new Map<string, ReasoningMode>();
const _pendingSessionModelPatches = new Map<string, string | null>();
let _loadSessionsInFlight: Promise<void> | null = null;
let _lastLoadSessionsAt = 0;
const _historyLoadInFlight = new Map<string, Promise<void>>();
const _lastHistoryLoadAtBySession = new Map<string, number>();
const _foregroundHistoryLoadSeen = new Set<string>();

/** When `applyLoadedMessages` returns false (user switched away mid-load). Used so awaiters of `_historyLoadInFlight` can schedule a follow-up fetch. */
const _historyApplyDiscardedForKey = new Set<string>();

/** Monotonic counter so only the latest foreground `loadHistory` run may clear `loading` (avoids stuck spinner / races when switching sessions quickly). */
let _historyLoadGeneration = 0;

type InterruptedSendSessionState = {
  sessionKey: string;
  activeRunId: string | null;
  lastUserMessageAt: number | null;
  /** Last real user message when leaving ??merge if history lags behind the gateway. */
  fallbackUserMessage: RawMessage | null;
};

/** Preserves mid-send UI when switching sessions; cleared after resume or completion. */
let _interruptedSendSession: InterruptedSendSessionState | null = null;

// ���� Silent tool stream error retry ����
// When a model produces a tool-call-stream error (list index out of range, malformed
// tool_calls, etc.), we retry ONCE silently without showing the error to the user.
// The retry replays the last sendMessage call with the same params. If it fails again,
// the user sees a friendly error message.
type LastSendParams = { text: string; attachments?: Array<{ fileName: string; mimeType: string; fileSize: number; stagedPath: string; preview: string | null }>; targetAgentId?: string | null };
type PendingSilentRetry = {
  failedRunId: string;
  sessionKey: string;
  params: LastSendParams;
};

let _lastSendParams: LastSendParams | null = null;
let _retriedRunIds = new Set<string>();
let _suppressNextOptimisticUserMessage = false;
let _pendingSilentRetry: PendingSilentRetry | null = null;
const _digitalEmployeeRuns = new Map<string, { agentId: string; name: string }>();

function isToolStreamError(error: string): boolean {
  const normalized = error.toLowerCase();
  return (
    normalized.includes('list index out of range')
    || normalized.includes('tool call stream error')
    || normalized.includes('malformed tool_call')
    || normalized.includes('model did not return tool call')
    || normalized.includes('tool_calls.arguments')
  );
}

function normalizeRuntimeErrorMessage(error: string): string {
  const trimmed = error.trim();
  const normalized = trimmed.toLowerCase();

  if (isToolStreamError(normalized)) {
    console.warn('[chat.runtime] tool stream error, will trigger silent retry', { error: trimmed });
    // Return the original error; the caller decides whether to retry or display
    return trimmed;
  }

  return trimmed || 'An error occurred';
}

function annotateDigitalEmployeeMessage<T extends RawMessage | null | undefined>(
  message: T,
  runId: string | null | undefined,
): T {
  if (!message || !runId) return message;
  const employee = _digitalEmployeeRuns.get(runId);
  if (!employee || message.role !== 'assistant') return message;
  return {
    ...message,
    executedByAgentId: employee.agentId,
    executedByAgentName: employee.name,
  } as T;
}

function annotateDigitalEmployeeHistoryMessages(messages: RawMessage[]): RawMessage[] {
  if (_digitalEmployeeRuns.size === 0) return messages;
  return messages.map((message) => {
    if (!message || message.role !== 'assistant' || message.executedByAgentId) return message;
    const id = typeof message.id === 'string' ? message.id : '';
    if (!id) return message;
    for (const [runId, employee] of _digitalEmployeeRuns) {
      if (id === runId || id.includes(runId)) {
        return {
          ...message,
          executedByAgentId: employee.agentId,
          executedByAgentName: employee.name,
        };
      }
    }
    return message;
  });
}

const SESSION_LOAD_MIN_INTERVAL_MS = 1_200;
const REASONING_MODE_STORAGE_KEY = 'LYClaw:chat:reasoning-mode';
const SESSION_REASONING_MODES_STORAGE_KEY = 'LYClaw:chat:session-reasoning-modes';

function isReasoningMode(value: unknown): value is ReasoningMode {
  return value === 'fast' || value === 'thinking';
}

function loadStoredReasoningMode(): ReasoningMode {
  try {
    const stored = window.localStorage.getItem(REASONING_MODE_STORAGE_KEY);
    return isReasoningMode(stored) ? stored : 'thinking';
  } catch {
    return 'thinking';
  }
}

function loadSessionReasoningModesFromStorage(): Record<string, ReasoningMode> {
  try {
    const raw = window.localStorage.getItem(SESSION_REASONING_MODES_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, ReasoningMode> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof k === 'string' && k && isReasoningMode(v)) {
        out[k] = v;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function persistSessionReasoningModesToStorage(modes: Record<string, ReasoningMode>): void {
  try {
    window.localStorage.setItem(SESSION_REASONING_MODES_STORAGE_KEY, JSON.stringify(modes));
  } catch {
    // Ignore storage failures.
  }
}

let _lastPersistedSessionReasoningModes = '';

function persistSessionReasoningModesIfChanged(modes: Record<string, ReasoningMode>): void {
  const serialized = JSON.stringify(modes);
  if (serialized === _lastPersistedSessionReasoningModes) return;
  _lastPersistedSessionReasoningModes = serialized;
  persistSessionReasoningModesToStorage(modes);
}

_lastPersistedSessionReasoningModes = JSON.stringify(loadSessionReasoningModesFromStorage());

const SESSION_WORKSPACE_IDS_STORAGE_KEY = 'LYClaw:chat:session-workspace-ids';

function loadSessionWorkspaceIdsFromStorage(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(SESSION_WORKSPACE_IDS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof k === 'string' && k && typeof v === 'string' && v) {
        out[k] = v;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function persistSessionWorkspaceIdsToStorage(ids: Record<string, string>): void {
  try {
    window.localStorage.setItem(SESSION_WORKSPACE_IDS_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // Ignore quota / private mode.
  }
}

let _lastPersistedSessionWorkspaceIds = '';

function persistSessionWorkspaceIdsIfChanged(ids: Record<string, string>): void {
  const serialized = JSON.stringify(ids);
  if (serialized === _lastPersistedSessionWorkspaceIds) return;
  _lastPersistedSessionWorkspaceIds = serialized;
  persistSessionWorkspaceIdsToStorage(ids);
}

_lastPersistedSessionWorkspaceIds = JSON.stringify(loadSessionWorkspaceIdsFromStorage());

const CUSTOM_SESSION_LABELS_STORAGE_KEY = 'LYClaw:chat:custom-session-labels';

function loadCustomSessionLabelsFromStorage(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(CUSTOM_SESSION_LABELS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof k === 'string' && k && typeof v === 'string' && v) {
        out[k] = v;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function persistCustomSessionLabelsToStorage(labels: Record<string, string>): void {
  try {
    window.localStorage.setItem(CUSTOM_SESSION_LABELS_STORAGE_KEY, JSON.stringify(labels));
  } catch {
    // Ignore quota / private mode failures; in-memory state still reflects the change.
  }
}

const SESSION_PINNED_AT_STORAGE_KEY = 'LYClaw:chat:session-pinned-at';

function loadSessionPinnedAtFromStorage(): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(SESSION_PINNED_AT_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof k === 'string' && k && typeof v === 'number' && Number.isFinite(v) && v > 0) {
        out[k] = v;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function persistSessionPinnedAtToStorage(pinnedAt: Record<string, number>): void {
  try {
    window.localStorage.setItem(SESSION_PINNED_AT_STORAGE_KEY, JSON.stringify(pinnedAt));
  } catch {
    // Ignore quota / private mode failures; in-memory state still reflects the change.
  }
}

let _lastPersistedSessionPinnedAt = '';

function persistSessionPinnedAtIfChanged(pinnedAt: Record<string, number>): void {
  const serialized = JSON.stringify(pinnedAt);
  if (serialized === _lastPersistedSessionPinnedAt) return;
  _lastPersistedSessionPinnedAt = serialized;
  persistSessionPinnedAtToStorage(pinnedAt);
}

_lastPersistedSessionPinnedAt = JSON.stringify(loadSessionPinnedAtFromStorage());

function toThinkingLevel(mode: ReasoningMode): 'off' | 'medium' {
  return mode === 'fast' ? 'off' : 'medium';
}

async function patchSessionThinkingLevel(sessionKey: string, mode: ReasoningMode): Promise<void> {
  await useGatewayStore.getState().rpc('sessions.patch', {
    key: sessionKey,
    thinkingLevel: toThinkingLevel(mode),
  }, 5_000);
}

async function patchSessionModel(sessionKey: string, model: string | null): Promise<void> {
  await useGatewayStore.getState().rpc('sessions.patch', {
    key: sessionKey,
    model,
  }, 5_000);
}

function isSlashCommand(message: string): boolean {
  return message.trimStart().startsWith('/');
}

type ReasoningDecision = {
  effectiveMode: ReasoningMode;
  reason: string;
  rule: string;
  confidence: number;
};

function normalizeLightweightInput(message: string): string {
  return message
    .trim()
    .toLowerCase()
    .replace(/[\s，。！？!?,.～~、；;：:]+/g, '');
}

function getReasoningDecision(message: string, selectedMode: ReasoningMode, hasMedia: boolean): ReasoningDecision {
  if (hasMedia) {
    return { effectiveMode: selectedMode, reason: 'media input keeps selected reasoning', rule: 'media', confidence: 1 };
  }
  if (isSlashCommand(message)) {
    return { effectiveMode: selectedMode, reason: 'slash command controls its own reasoning', rule: 'slash-command', confidence: 1 };
  }

  const trimmed = message.trim();
  if (!trimmed) {
    return { effectiveMode: selectedMode, reason: 'empty text keeps selected reasoning', rule: 'empty', confidence: 1 };
  }

  const normalized = normalizeLightweightInput(trimmed);
  const simplePhrases = new Set([
    'hello', 'hi', 'hey', '你好', '您好', '在吗', '在嘛', '哈喽', '嗨',
    '谢谢', 'thanks', 'thankyou', 'ok', '好的', '好', '嗯',
  ]);
  if (simplePhrases.has(normalized)) {
    return { effectiveMode: 'fast', reason: 'simple acknowledgement or greeting', rule: 'simple-phrase', confidence: 1 };
  }

  const hasCodeBlock = /```|`[^`]+`/.test(trimmed);
  if (hasCodeBlock) {
    return { effectiveMode: selectedMode, reason: 'code-like input keeps selected reasoning', rule: 'code-block', confidence: 0.95 };
  }

  const complexPattern = /(分析|排查|定位|优化|实现|设计|方案|重构|修复|代码|报错|架构|对比|规划|评估|总结|改造|测试|单元测试|接口|数据库|性能|安全|根因|复杂|详细|步骤|计划|analy[sz]e|debug|investigate|implement|refactor|design|architecture|optimi[sz]e|code|error|compare|plan|evaluate|performance|security|root cause|test)/i;
  if (complexPattern.test(trimmed)) {
    return { effectiveMode: selectedMode, reason: 'complex task keeps selected reasoning', rule: 'complex-keyword', confidence: 0.9 };
  }

  const shortQuery = trimmed.length <= 180;
  if (shortQuery) {
    return { effectiveMode: 'fast', reason: 'aggressive fast path for short query', rule: 'short-query', confidence: 0.8 };
  }

  return { effectiveMode: selectedMode, reason: 'long input keeps selected reasoning', rule: 'long-input', confidence: 0.75 };
}

function withThinkingDirective(message: string, mode: ReasoningMode): string {
  if (isSlashCommand(message)) {
    return message;
  }
  return `/think ${toThinkingLevel(mode)} ${message}`;
}

// Strip legacy mimo directive from message text for display
function maybeStripMimoDirective(text: string): string {
  const directiveMarker = '[系统指令]';
  const directiveStart = text.lastIndexOf(directiveMarker);

  if (directiveStart < 0) {
    return text;
  }

  const endMarkers = ['必须使用中文输出内容。', '必须全程使用中文。'];
  if (endMarkers.some((marker) => text.indexOf(marker, directiveStart) >= 0)) {
    return text.slice(0, directiveStart).trimEnd();
  }

  return text;
}

const COMPLEX_TASK_EXECUTION_GUIDE = [
  '',
  '[LYClaw execution guide for complex build/edit tasks]',
  '- Send a short plan or progress note before long generation.',
  '- Do not read large source files in full. Use search, summaries, or limited reads first.',
  '- Do not rewrite an existing large file in one write. Prefer targeted patches or module-sized edits.',
  '- Split large HTML/app/report work into small steps: skeleton, parser, charts, risk model, export, verification.',
  '- Keep each model turn and tool write small enough that progress is visible regularly.',
  '- If a file may exceed about 20KB, create or update it in sections and report progress between sections.',
  '[/LYClaw execution guide]',
].join('\n');

const COMPLEX_TASK_PLAN_MARKER = '[LYClaw complex task planning phase]';
const COMPLEX_TASK_EXECUTION_MARKER = '[LYClaw staged execution phase]';

type PendingComplexTaskPlan = {
  originalMessage: string;
  workspaceContext: string;
  reasoningMode: ReasoningMode;
  attachmentCount: number;
  planningRunId: string | null;
};

const _pendingComplexTaskPlans = new Map<string, PendingComplexTaskPlan>();

function looksLikeComplexBuildTask(message: string, attachmentCount: number): boolean {
  // Temporarily disabled: the automatic complex-task planning/execution split
  // was leaking internal control prompts into visible chat history. Keep the
  // parser/cleanup code in place so old transcripts are still normalized.
  void message;
  void attachmentCount;
  return false;

  const normalized = message.toLowerCase();
  if (
    message.includes(COMPLEX_TASK_PLAN_MARKER)
    || message.includes(COMPLEX_TASK_EXECUTION_MARKER)
  ) return false;
  if (attachmentCount > 0) return true;
  if (message.length >= 260) return true;
  return [
    'html',
    'dashboard',
    '看板',
    '可视化',
    '报告',
    'word',
    'excel',
    'xlsx',
    '图表',
    '上传',
    '生成',
    '实现功能',
    '完整',
  ].some((needle) => normalized.includes(needle));
}

function withComplexTaskExecutionGuide(message: string, attachmentCount: number): string {
  void attachmentCount;
  return message;

  if (!looksLikeComplexBuildTask(message, attachmentCount)) return message;
  if (message.includes('[LYClaw execution guide for complex build/edit tasks]')) return message;
  return `${message}\n${COMPLEX_TASK_EXECUTION_GUIDE}`;
}

function shouldUseComplexTaskPlanning(message: string, attachmentCount: number): boolean {
  return looksLikeComplexBuildTask(message, attachmentCount);
}

function buildComplexTaskPlanningRequest(message: string): string {
  return [
    COMPLEX_TASK_PLAN_MARKER,
    '你现在只做规划握手，不要开始实现。',
    '请只输出 3-6 步执行计划，每步一句话。',
    '不要写代码，不要调用工具，不要读取文件，不要创建文件。',
    '计划要体现分块执行：骨架、数据解析、图表、风险模型、报告导出、验证。',
    '',
    '用户原始需求：',
    message,
  ].join('\n');
}

function buildComplexTaskExecutionRequest(originalMessage: string, planText: string): string {
  return [
    COMPLEX_TASK_EXECUTION_MARKER,
    '请按上一步计划开始执行。每次只完成一个模块，完成后汇报进度，不要一次性生成或重写大文件。',
    '优先创建骨架，再逐步 patch/补充模块。避免完整读取大文件；避免一次性写入超过约 20KB 的内容。',
    '',
    '上一步计划：',
    planText.trim() || '(计划未能从消息中提取，请按分块原则执行。)',
    '',
    '用户原始需求：',
    originalMessage,
    COMPLEX_TASK_EXECUTION_GUIDE,
  ].join('\n');
}

function extractOriginalMessageFromComplexTaskPrompt(text: string): string {
  const markers = ['用户原始需求：', '用户原始需求:'];
  for (const marker of markers) {
    const index = text.lastIndexOf(marker);
    if (index >= 0) {
      const original = text.slice(index + marker.length).trim();
      if (original) return original;
    }
  }
  return text;
}

function normalizeComplexTaskControlUserMessages(messages: RawMessage[]): RawMessage[] {
  const visibleMessages: RawMessage[] = [];
  const seenUserTexts = new Set<string>();

  for (const message of messages) {
    if (message.role !== 'user') {
      visibleMessages.push(message);
      continue;
    }

    const text = getMessageText(message.content);

    // Strip mimo directive for comparison and display (applies to ALL user messages)
    const displayText = maybeStripMimoDirective(text);
    const comparable = normalizeComparableUserText(displayText);

    const isPlanningControl = displayText.includes(COMPLEX_TASK_PLAN_MARKER);
    const isExecutionControl = displayText.includes(COMPLEX_TASK_EXECUTION_MARKER);

    // Skip duplicate execution control messages (complex task feature)
    if (isExecutionControl && comparable && seenUserTexts.has(comparable)) {
      continue;
    }

    if (comparable) seenUserTexts.add(comparable);

    // Show stripped version to user, but keep original for history
    visibleMessages.push({
      ...message,
      content: displayText,
    });
  }

  return visibleMessages;
}

function abortGatewayRun(sessionKey: string): void {
  void useGatewayStore.getState().rpc(
    'sessions.abort',
    { key: sessionKey },
    8_000,
  ).catch((error) => {
    console.warn('[chat] Failed to abort stuck run:', error);
  });
}

function clearPendingSilentRetry(runId?: string | null): void {
  if (!runId || _pendingSilentRetry?.failedRunId === runId) {
    _pendingSilentRetry = null;
  }
}

function scheduleSilentToolStreamRetry(
  failedRunId: string,
  sessionKey: string,
  params: LastSendParams,
  get: () => ChatState,
): void {
  _pendingSilentRetry = { failedRunId, sessionKey, params };
  abortGatewayRun(sessionKey);

  setTimeout(() => {
    const pending = _pendingSilentRetry;
    if (
      !pending
      || pending.failedRunId !== failedRunId
      || pending.sessionKey !== sessionKey
      || get().currentSessionKey !== sessionKey
    ) {
      return;
    }

    _pendingSilentRetry = null;
    _suppressNextOptimisticUserMessage = true;
    const state = get();
    void state.sendMessage(pending.params.text, pending.params.attachments, pending.params.targetAgentId);
  }, 100);
}

function applySessionThinkingLevelInBackground(
  sessionKey: string,
  mode: ReasoningMode,
  set: (partial: Partial<ChatState>) => void,
): { needsPatch: boolean } {
  void sessionKey;
  set({ thinkingLevel: toThinkingLevel(mode) });
  return { needsPatch: true };
}

const THINKING_LEVEL_PATCH_IDLE_DELAY_MS = 5_000;

function scheduleThinkingLevelPatchFlush(delayMs = THINKING_LEVEL_PATCH_IDLE_DELAY_MS): void {
  if (_thinkingLevelPatchTimer) return;
  _thinkingLevelPatchTimer = setTimeout(() => {
    _thinkingLevelPatchTimer = null;
    void flushPendingThinkingLevelPatches();
  }, delayMs);
}

async function flushPendingThinkingLevelPatches(): Promise<void> {
  if (_pendingThinkingLevelPatches.size === 0) return;
  const state = useChatStore.getState();
  if (state.sending || state.activeRunId) {
    scheduleThinkingLevelPatchFlush();
    return;
  }

  const pending = [..._pendingThinkingLevelPatches.entries()];
  _pendingThinkingLevelPatches.clear();
  for (const [sessionKey, mode] of pending) {
    try {
      await patchSessionThinkingLevel(sessionKey, mode);
    } catch (error) {
      console.warn('[chat] Failed to persist thinking level; continuing with one-shot /think directive:', error);
    }
  }
}

function deferSessionThinkingLevelPatch(sessionKey: string, mode: ReasoningMode): void {
  _pendingThinkingLevelPatches.set(sessionKey, mode);
  scheduleThinkingLevelPatchFlush();
}

const SESSION_MODEL_PATCH_IDLE_DELAY_MS = 1_000;

function scheduleSessionModelPatchFlush(delayMs = SESSION_MODEL_PATCH_IDLE_DELAY_MS): void {
  if (_sessionModelPatchTimer) return;
  _sessionModelPatchTimer = setTimeout(() => {
    _sessionModelPatchTimer = null;
    void flushPendingSessionModelPatches();
  }, delayMs);
}

async function flushPendingSessionModelPatches(sessionKey?: string): Promise<void> {
  if (_pendingSessionModelPatches.size === 0) return;
  const state = useChatStore.getState();
  if (state.sending || state.activeRunId) {
    scheduleSessionModelPatchFlush();
    return;
  }

  const pending = sessionKey && _pendingSessionModelPatches.has(sessionKey)
    ? [[sessionKey, _pendingSessionModelPatches.get(sessionKey)!] as const]
    : [..._pendingSessionModelPatches.entries()];

  for (const [pendingSessionKey, model] of pending) {
    try {
      await patchSessionModel(pendingSessionKey, model);
      _pendingSessionModelPatches.delete(pendingSessionKey);
    } catch (error) {
      console.warn('[chat] Failed to persist session model; will retry later:', error);
      scheduleSessionModelPatchFlush(5_000);
    }
  }
}

function deferSessionModelPatch(sessionKey: string, model: string | null): void {
  _pendingSessionModelPatches.set(sessionKey, model);
  scheduleSessionModelPatchFlush();
}

function getSessionModel(sessions: ChatSession[], sessionKey: string): string | undefined {
  return sessions.find((session) => session.key === sessionKey)?.model;
}

const HISTORY_LOAD_MIN_INTERVAL_MS = 800;
const ACTIVE_SEND_HISTORY_FALLBACK_INITIAL_DELAY_MS = 2_000;
const ACTIVE_SEND_HISTORY_FALLBACK_DELAYS_MS = [3_000, 5_000];
const ACTIVE_SEND_HISTORY_FALLBACK_REPEAT_MS = 6_000;
const ACTIVE_SEND_HISTORY_FALLBACK_STREAMING_DELAY_MS = 10_000;
const TOOL_EXECUTION_STALE_MS = 2 * 60_000;
const CHAT_EVENT_DEDUPE_TTL_MS = 30_000;
const _chatEventDedupe = new Map<string, number>();
const _lastRuntimeTranscriptProgressSignatureBySession = new Map<string, string>();

function clearErrorRecoveryTimer(): void {
  if (_errorRecoveryTimer) {
    clearTimeout(_errorRecoveryTimer);
    _errorRecoveryTimer = null;
  }
}

function clearHistoryPoll(): void {
  if (_historyPollTimer) {
    clearTimeout(_historyPollTimer);
    _historyPollTimer = null;
  }
}

const ABORT_HISTORY_QUIET_MS = 2_000;
let _abortHistoryQuietUntil = 0;

function markAbortHistoryQuietPeriod(ms = ABORT_HISTORY_QUIET_MS): void {
  _abortHistoryQuietUntil = Date.now() + ms;
}

function isAbortHistoryQuietPeriod(): boolean {
  return Date.now() < _abortHistoryQuietUntil;
}

function hasLiveStreamContent(state: Pick<ChatState, 'streamingMessage' | 'streamingText' | 'streamingTools'>): boolean {
  if (state.streamingText && state.streamingText.trim()) return true;
  if (state.streamingTools.length > 0) return true;
  return classifyVisibleProgress(state.streamingMessage).visible;
}

function startActiveSendHistoryFallback(sessionKey: string): void {
  clearHistoryPoll();
  let attempt = 0;

  const scheduleNext = (delayMs: number) => {
    _historyPollTimer = setTimeout(async () => {
      _historyPollTimer = null;
      const state = useChatStore.getState();
      if (state.currentSessionKey !== sessionKey || !state.sending) return;

      try {
        await state.loadHistory(true, { force: attempt > 0 });
      } catch (error) {
        console.warn('[chat.history-fallback] local transcript refresh failed', {
          sessionKey,
          error: String(error),
        });
      }

      const nextState = useChatStore.getState();
      if (nextState.currentSessionKey !== sessionKey || !nextState.sending) return;

      attempt += 1;
      const nextDelay = hasLiveStreamContent(nextState)
        ? ACTIVE_SEND_HISTORY_FALLBACK_STREAMING_DELAY_MS
        : ACTIVE_SEND_HISTORY_FALLBACK_DELAYS_MS[attempt] ?? ACTIVE_SEND_HISTORY_FALLBACK_REPEAT_MS;
      scheduleNext(nextDelay);
    }, delayMs);
  };

  scheduleNext(ACTIVE_SEND_HISTORY_FALLBACK_INITIAL_DELAY_MS);
}

function pruneChatEventDedupe(now: number): void {
  for (const [key, ts] of _chatEventDedupe.entries()) {
    if (now - ts > CHAT_EVENT_DEDUPE_TTL_MS) {
      _chatEventDedupe.delete(key);
    }
  }
}

function buildChatEventDedupeKey(eventState: string, event: Record<string, unknown>): string | null {
  const runId = event.runId != null ? String(event.runId) : '';
  const sessionKey = event.sessionKey != null ? String(event.sessionKey) : '';
  const seq = event.seq != null ? String(event.seq) : '';
  // Some gateways emit multiple streaming/final updates without a monotonically
  // increasing `seq`. Deduping those by just `runId + sessionKey + state`
  // collapses legitimate stream progression and can drop the final assistant reply.
  if ((eventState === 'delta' || eventState === 'final') && !seq) {
    return null;
  }
  if (runId || sessionKey || seq || eventState) {
    return [runId, sessionKey, seq, eventState].join('|');
  }
  const msg = (event.message && typeof event.message === 'object')
    ? event.message as Record<string, unknown>
    : null;
  if (msg) {
    const messageId = msg.id != null ? String(msg.id) : '';
    const stopReason = msg.stopReason ?? msg.stop_reason;
    if (messageId || stopReason) {
      return `msg|${messageId}|${String(stopReason ?? '')}|${eventState}`;
    }
  }
  return null;
}

function getFinalMessageIdDedupeKey(eventState: string, event: Record<string, unknown>): string | null {
  if (eventState !== 'final') return null;
  const msg = (event.message && typeof event.message === 'object')
    ? event.message as Record<string, unknown>
    : null;
  if (msg?.id != null) return `final-msgid|${String(msg.id)}`;
  return null;
}

function isDuplicateChatEvent(eventState: string, event: Record<string, unknown>): boolean {
  const key = buildChatEventDedupeKey(eventState, event);
  const msgKey = getFinalMessageIdDedupeKey(eventState, event);
  if (!key && !msgKey) return false;
  const now = Date.now();
  pruneChatEventDedupe(now);
  if ((key && _chatEventDedupe.has(key)) || (msgKey && _chatEventDedupe.has(msgKey))) {
    return true;
  }
  if (key) _chatEventDedupe.set(key, now);
  if (msgKey) _chatEventDedupe.set(msgKey, now);
  return false;
}

// ���� Local image cache ����������������������������������������������������������������������������������
// The Gateway doesn't store image attachments in session content blocks,
// so we cache them locally keyed by staged file path (which appears in the
// [media attached: <path> ...] reference in the Gateway's user message text).
// Keying by path avoids the race condition of keying by runId (which is only
// available after the RPC returns, but history may load before that).
const IMAGE_CACHE_KEY = 'LYClaw:image-cache';
const IMAGE_CACHE_MAX = 100; // max entries to prevent unbounded growth

function loadImageCache(): Map<string, AttachedFileMeta> {
  try {
    const raw = localStorage.getItem(IMAGE_CACHE_KEY);
    if (raw) {
      const entries = JSON.parse(raw) as Array<[string, AttachedFileMeta]>;
      return new Map(entries);
    }
  } catch { /* ignore parse errors */ }
  return new Map();
}

function saveImageCache(cache: Map<string, AttachedFileMeta>): void {
  try {
    // Evict oldest entries if over limit
    const entries = Array.from(cache.entries());
    const trimmed = entries.length > IMAGE_CACHE_MAX
      ? entries.slice(entries.length - IMAGE_CACHE_MAX)
      : entries;
    localStorage.setItem(IMAGE_CACHE_KEY, JSON.stringify(trimmed));
  } catch { /* ignore quota errors */ }
}

const _imageCache = loadImageCache();

function normalizeBlockText(text: string | undefined): string {
  return typeof text === 'string' ? text.replace(/\r\n/g, '\n').trim() : '';
}

function compactProgressiveTextParts(parts: string[]): string[] {
  const compacted: string[] = [];

  for (const part of parts) {
    const current = normalizeBlockText(part);
    if (!current) continue;

    const previous = compacted.at(-1);
    if (!previous) {
      compacted.push(part);
      continue;
    }

    const normalizedPrevious = normalizeBlockText(previous);
    if (!normalizedPrevious) {
      compacted[compacted.length - 1] = part;
      continue;
    }

    if (current === normalizedPrevious || normalizedPrevious.startsWith(current)) {
      continue;
    }

    if (current.startsWith(normalizedPrevious)) {
      compacted[compacted.length - 1] = part;
      continue;
    }

    compacted.push(part);
  }

  return compacted;
}

const REASONING_FIELD_NAMES = [
  'reasoning_content',
  'reasoningContent',
  'reasoning',
  'reasoningText',
  'thinking',
] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function collectReasoningFields(record: Record<string, unknown> | null): string[] {
  if (!record) return [];
  const parts: string[] = [];
  for (const field of REASONING_FIELD_NAMES) {
    const value = record[field];
    if (typeof value === 'string' && value.trim()) {
      parts.push(value.trim());
    }
  }
  return parts;
}

function normalizeReasoningContentBlock(block: ContentBlock): ContentBlock {
  const record = block as unknown as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : '';
  if (type === 'thinking') {
    return { ...block };
  }

  const reasoningParts = collectReasoningFields(record);
  if (reasoningParts.length === 0 && (type === 'reasoning' || type === 'reasoning_content')) {
    const text = typeof record.text === 'string' ? record.text.trim() : '';
    if (text) reasoningParts.push(text);
  }

  if (reasoningParts.length === 0) {
    return { ...block };
  }

  return {
    ...block,
    type: 'thinking',
    thinking: reasoningParts.join('\n'),
  };
}

function normalizeLiveContentBlocks(content: ContentBlock[]): ContentBlock[] {
  return content.map(normalizeReasoningContentBlock);
}

function contentToBlocks(content: unknown): ContentBlock[] {
  if (Array.isArray(content)) return normalizeLiveContentBlocks(content as ContentBlock[]);
  if (typeof content === 'string' && content.trim()) {
    return [{ type: 'text', text: content }];
  }
  return [];
}

function collectReasoningFromMessage(record: Record<string, unknown>): string[] {
  const parts = collectReasoningFields(record);
  for (const nestedKey of ['delta', 'message']) {
    parts.push(...collectReasoningFields(asRecord(record[nestedKey])));
  }
  const choices = record.choices;
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      const choiceRecord = asRecord(choice);
      parts.push(...collectReasoningFields(choiceRecord));
      parts.push(...collectReasoningFields(asRecord(choiceRecord?.delta)));
      parts.push(...collectReasoningFields(asRecord(choiceRecord?.message)));
    }
  }
  return compactProgressiveTextParts(parts).filter(Boolean);
}

function stripTopLevelReasoningFields(record: Record<string, unknown>): Record<string, unknown> {
  const next = { ...record };
  for (const field of REASONING_FIELD_NAMES) {
    delete next[field];
  }
  return next;
}

function normalizeStreamingMessage(message: unknown): unknown {
  if (!message || typeof message !== 'object') return message;

  const msgRecord = message as Record<string, unknown>;
  const reasoningParts = collectReasoningFromMessage(msgRecord);
  const rawContent = msgRecord.content;
  const contentBlocks = contentToBlocks(rawContent);
  const existingThinking = new Set(
    contentBlocks
      .filter((block) => block.type === 'thinking' && typeof block.thinking === 'string')
      .map((block) => normalizeBlockText(block.thinking)),
  );
  const reasoningBlocks = reasoningParts
    .filter((part) => !existingThinking.has(normalizeBlockText(part)))
    .map((thinking): ContentBlock => ({ type: 'thinking', thinking }));

  const normalizedContent = [...reasoningBlocks, ...contentBlocks];
  const didChange = reasoningBlocks.length > 0
    || !Array.isArray(rawContent)
    || normalizedContent.some((block, index) => block !== (rawContent as ContentBlock[])[index])
    || normalizedContent.length !== (Array.isArray(rawContent) ? rawContent.length : 0);

  if (reasoningBlocks.length > 0) {
    console.debug('[chat] normalized reasoning content', {
      fields: Object.keys(msgRecord).filter((key) => key.toLowerCase().includes('reason') || key.toLowerCase().includes('thinking')),
      chars: reasoningBlocks.reduce((sum, block) => sum + (block.thinking?.length ?? 0), 0),
    });
  }

  return didChange
    ? { ...stripTopLevelReasoningFields(msgRecord), content: normalizedContent }
    : message;
}

function snapshotStreamingAssistantMessage(
  currentStream: RawMessage | null,
  existingMessages: RawMessage[],
  runId: string,
): RawMessage[] {
  if (!currentStream) return [];

  const normalizedStream = annotateDigitalEmployeeMessage(
    normalizeStreamingMessage(currentStream) as RawMessage,
    runId,
  ) as RawMessage;
  const streamRole = normalizedStream.role;
  if (streamRole !== 'assistant' && streamRole !== undefined) return [];

  const snapId = normalizedStream.id || `${runId || 'run'}-turn-${existingMessages.length}`;
  if (existingMessages.some((message) => message.id === snapId)) return [];

  return [{
    ...normalizedStream,
    role: 'assistant',
    id: snapId,
  }];
}

/** Keep locally sent user messages when Gateway transcript has not persisted them yet (e.g. after abort). */
function mergeMissingLocalUserMessages(
  pipelineMessages: RawMessage[],
  localMessages: RawMessage[],
): RawMessage[] {
  let merged = [...pipelineMessages];
  for (const localMsg of localMessages) {
    if (localMsg.role !== 'user') continue;
    const localTimestampMs = localMsg.timestamp != null ? toMs(localMsg.timestamp as number) : 0;
    const exists = merged.some((message) =>
      matchesOptimisticUserMessage(message, localMsg, localTimestampMs || Date.now()),
    );
    if (!exists) {
      merged.push(localMsg);
    }
  }
  if (merged.length === pipelineMessages.length) return pipelineMessages;
  merged.sort((a, b) => {
    const ta = a.timestamp != null ? toMs(a.timestamp as number) : 0;
    const tb = b.timestamp != null ? toMs(b.timestamp as number) : 0;
    return ta - tb;
  });
  return merged;
}

function buildSessionRegistrationPatch(
  state: Pick<ChatState, 'sessions' | 'sessionLabels' | 'sessionLastActivity' | 'sessionWorkspaceIds'>,
  sessionKey: string,
  userMessage: RawMessage | null,
  workspaceId: string | null,
): Partial<Pick<ChatState, 'sessions' | 'sessionLabels' | 'sessionLastActivity' | 'sessionWorkspaceIds'>> {
  if (!userMessage) return {};
  const rawText = stripGatewayUserMetadata(getMessageText(userMessage.content)).trim();
  if (!rawText) return {};

  const truncated = rawText.length > 50 ? `${rawText.slice(0, 50)}…` : rawText;
  const nowMs = userMessage.timestamp != null ? toMs(userMessage.timestamp as number) : Date.now();
  const boundWorkspaceId = state.sessionWorkspaceIds[sessionKey] ?? workspaceId ?? null;

  return {
    sessions: ensureSessionEntry(state.sessions, sessionKey),
    sessionLabels: state.sessionLabels[sessionKey]
      ? state.sessionLabels
      : { ...state.sessionLabels, [sessionKey]: truncated },
    sessionLastActivity: { ...state.sessionLastActivity, [sessionKey]: nowMs },
    sessionWorkspaceIds: boundWorkspaceId
      ? { ...state.sessionWorkspaceIds, [sessionKey]: boundWorkspaceId }
      : state.sessionWorkspaceIds,
  };
}

function createEmptySessionStreamingState(): SessionStreamingState {
  return {
    activeRunId: null,
    activeTool: null,
    streamingText: '',
    streamingMessage: null,
    streamingTools: [],
    pendingFinal: false,
    lastUserMessageAt: null,
    pendingToolImages: [],
    runAborted: false,
    runError: null,
    sending: false,
    messagesSnapshot: [],
  };
}

function snapshotCurrentStreamingState(state: ChatState): SessionStreamingState {
  return {
    activeRunId: state.activeRunId,
    activeTool: state.activeTool,
    streamingText: state.streamingText,
    streamingMessage: state.streamingMessage,
    streamingTools: state.streamingTools,
    pendingFinal: state.pendingFinal,
    lastUserMessageAt: state.lastUserMessageAt,
    pendingToolImages: state.pendingToolImages,
    runAborted: state.runAborted,
    runError: state.runError,
    sending: state.sending,
    messagesSnapshot: state.messages.length > 0 ? [...state.messages] : (state.sessionStreamingStates[state.currentSessionKey]?.messagesSnapshot ?? []),
  };
}

function applyClearedActiveRunForSession(
  set: (partial: Partial<ChatState> | ((state: ChatState) => Partial<ChatState>)) => void,
  sessionKey: string,
  options?: { preserveMessagesSnapshot?: boolean },
): void {
  set((s) => {
    const cleared = buildClearedActiveRunPatch();
    const prevSnapshot = s.sessionStreamingStates[sessionKey] ?? createEmptySessionStreamingState();
    const messagesSnapshot = options?.preserveMessagesSnapshot === false
      ? []
      : (s.currentSessionKey === sessionKey && s.messages.length > 0
        ? [...s.messages]
        : (prevSnapshot.messagesSnapshot.length > 0 ? prevSnapshot.messagesSnapshot : []));
    return {
      ...cleared,
      sessionStreamingStates: {
        ...s.sessionStreamingStates,
        [sessionKey]: {
          ...prevSnapshot,
          ...cleared,
          messagesSnapshot,
        },
      },
    };
  });
}

function appendMessageIfMissing(messages: RawMessage[], message: RawMessage): RawMessage[] {
  if (message.id && messages.some((existing) => existing.id === message.id)) return messages;
  return [...messages, message];
}

function applyBackgroundChatEvent(
  state: ChatState,
  sessionKey: string,
  event: Record<string, unknown>,
  resolvedState: string,
  runId: string,
): Record<string, SessionStreamingState> | null {
  if (isUserAbortedSession(sessionKey) && (resolvedState === 'started' || resolvedState === 'delta')) {
    return null;
  }

  const existing = state.sessionStreamingStates[sessionKey] ?? createEmptySessionStreamingState();
  if (!shouldProcessCurrentSessionRunEvent(existing.activeRunId, runId)) return null;

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
          next.streamingMessage = msgContent.trim() && shouldSuppressAssistantStreamingText(msgContent)
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
 * Remove duplicate user messages that share the same normalized text content.
 * This is a content-based safety net that catches duplicates missed by the
 * timestamp-based `matchesOptimisticUserMessage` (which requires messages
 * to be within 5 seconds of each other). When loading history, the pipeline
 * (JSONL) and snapshot messages may have different timestamps yet identical
 * content — the same user question should never appear twice in the UI.
 */
function dedupeUserMessagesByContent(messages: RawMessage[]): RawMessage[] {
  if (messages.length < 2) return messages;

  const seen = new Set<string>();
  const result: RawMessage[] = [];

  for (const message of messages) {
    if (message.role !== 'user') {
      result.push(message);
      continue;
    }
    const key = normalizeComparableUserText(message.content);
    if (!key) {
      result.push(message);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(message);
  }

  return result.length === messages.length ? messages : result;
}

function resolveFinalMessagesWithLocalPreservation(
  sessionKey: string,
  pipelineMessages: RawMessage[],
  get: () => ChatState,
): RawMessage[] {
  const state = get();
  let finalMessages = mergeMissingLocalUserMessages(pipelineMessages, state.messages);

  const userMsgAt = state.lastUserMessageAt;
  if (state.sending && userMsgAt) {
    const userMsMs = toMs(userMsgAt);
    const optimistic = getLatestOptimisticUserMessage(state.messages, userMsMs);
    if (optimistic) {
      const optimisticTimestampMs = optimistic.timestamp != null
        ? toMs(optimistic.timestamp as number)
        : userMsMs;
      const hasMatchingUser = finalMessages.some((message) =>
        matchesOptimisticUserMessage(message, optimistic, optimisticTimestampMs),
      );
      if (!hasMatchingUser) {
        finalMessages = [...finalMessages, optimistic];
      }
    }
  }

  finalMessages = dedupeEquivalentAttachmentUserMessages(finalMessages);

  // Content-based user-message dedup: when the same user message appears in both
  // the pipeline (from JSONL) and the local snapshot, the timestamp-based
  // `matchesOptimisticUserMessage` may fail if timestamps differ by >5s.
  // This safety net catches those remaining duplicates by comparing normalized
  // text content — the same message with the same text should only appear once.
  finalMessages = dedupeUserMessagesByContent(finalMessages);

  if (finalMessages.length > 0) return finalMessages;
  if (state.messages.length > 0) return dedupeEquivalentAttachmentUserMessages(state.messages);

  const snapshot = state.sessionStreamingStates[sessionKey]?.messagesSnapshot;
  if (snapshot && snapshot.length > 0) return dedupeEquivalentAttachmentUserMessages(snapshot);

  const label = state.sessionLabels[sessionKey];
  if (label) {
    const activity = state.sessionLastActivity[sessionKey] ?? Date.now();
    return [{
      role: 'user',
      content: label.endsWith('…') ? label.slice(0, -1) : label,
      timestamp: activity / 1000,
      id: `local-${sessionKey}`,
    }];
  }

  return finalMessages;
}

/** Extract plain text from message content (string or content blocks) */
function getMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = (content as Array<{ type?: string; text?: string }>)
      .filter(b => b.type === 'text' && b.text)
      .map(b => b.text!);
    return compactProgressiveTextParts(parts).join('\n');
  }
  return '';
}

type VisibleProgressKind = 'assistant_text' | 'thinking_text' | 'thinking_block' | 'tool_use' | 'tool_result' | 'image' | 'tool_status' | 'placeholder' | 'none';

type VisibleProgressInfo = {
  visible: boolean;
  kind: VisibleProgressKind;
  messageBlockTypes: string[];
};

function getMessageBlockTypes(message: unknown): string[] {
  if (!message || typeof message !== 'object') return [];
  const msg = message as Record<string, unknown>;
  const types: string[] = [];
  const content = msg.content;
  if (Array.isArray(content)) {
    for (const block of content as Array<{ type?: unknown }>) {
      if (typeof block.type === 'string') types.push(block.type);
    }
  }
  if (Array.isArray(msg.tool_calls)) types.push('tool_calls');
  if (Array.isArray(msg.toolCalls)) types.push('toolCalls');
  return types;
}

function classifyVisibleProgress(message: unknown, streamingTools: ToolStatus[] = []): VisibleProgressInfo {
  if (streamingTools.length > 0) {
    return { visible: true, kind: 'tool_status', messageBlockTypes: getMessageBlockTypes(message) };
  }
  if (!message || typeof message !== 'object') {
    return { visible: false, kind: 'none', messageBlockTypes: [] };
  }

  const msg = message as RawMessage & Record<string, unknown>;
  const messageBlockTypes = getMessageBlockTypes(msg);
  if (isToolResultRole(msg.role)) {
    return { visible: true, kind: 'tool_result', messageBlockTypes };
  }

  const content = msg.content;
  if (typeof content === 'string') {
    return content.trim()
      ? { visible: true, kind: 'assistant_text', messageBlockTypes }
      : { visible: false, kind: 'placeholder', messageBlockTypes };
  }

  const toolCalls = msg.tool_calls ?? msg.toolCalls;
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    return { visible: true, kind: 'tool_use', messageBlockTypes };
  }

  if (!Array.isArray(content)) {
    return msg.role || Object.keys(msg).length > 0
      ? { visible: false, kind: 'placeholder', messageBlockTypes }
      : { visible: false, kind: 'none', messageBlockTypes };
  }

  let hasThinkingBlock = false;
  for (const block of content as ContentBlock[]) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      return { visible: true, kind: 'assistant_text', messageBlockTypes };
    }
    if (block.type === 'thinking') {
      hasThinkingBlock = true;
      if (typeof block.thinking === 'string' && block.thinking.trim()) {
        return { visible: true, kind: 'thinking_text', messageBlockTypes };
      }
    }
    if (block.type === 'tool_use' || block.type === 'toolCall') {
      return { visible: true, kind: 'tool_use', messageBlockTypes };
    }
    if (block.type === 'tool_result' || block.type === 'toolResult') {
      return { visible: true, kind: 'tool_result', messageBlockTypes };
    }
    if (block.type === 'image') {
      return { visible: true, kind: 'image', messageBlockTypes };
    }
  }

  if (hasThinkingBlock) {
    return { visible: true, kind: 'thinking_block', messageBlockTypes };
  }
  return { visible: false, kind: 'placeholder', messageBlockTypes };
}

function getRuntimeTranscriptProgress(
  messages: RawMessage[],
  userTimestampMs: number | null,
): {
  messageCount: number;
  assistantCount: number;
  toolResultCount: number;
  latestTimestamp: number | null;
  signature: string;
  visibleKind: VisibleProgressKind | null;
  toolUseCount: number;
  thinkingCount: number;
  assistantTextCount: number;
} | null {
  if (!userTimestampMs) return null;
  let messageCount = 0;
  let assistantCount = 0;
  let toolResultCount = 0;
  let toolUseCount = 0;
  let thinkingCount = 0;
  let assistantTextCount = 0;
  let visibleKind: VisibleProgressKind | null = null;
  let latestTimestamp: number | null = null;
  const ids: string[] = [];
  let contentChars = 0;

  for (const message of messages) {
    const timestamp = typeof message.timestamp === 'number' ? toMs(message.timestamp) : null;
    if (timestamp != null && timestamp < userTimestampMs) continue;
    if (message.role !== 'assistant' && !isToolResultRole(message.role)) continue;

    const progress = classifyVisibleProgress(message);
    if (!progress.visible && progress.kind !== 'placeholder') continue;

    messageCount += 1;
    if (message.role === 'assistant') assistantCount += 1;
    if (isToolResultRole(message.role)) toolResultCount += 1;
    if (progress.kind === 'tool_use') toolUseCount += 1;
    if (progress.kind === 'thinking_text' || progress.kind === 'thinking_block') thinkingCount += 1;
    if (progress.kind === 'assistant_text') assistantTextCount += 1;
    if (!visibleKind && progress.visible) visibleKind = progress.kind;
    if (timestamp != null) {
      latestTimestamp = latestTimestamp == null ? timestamp : Math.max(latestTimestamp, timestamp);
    }
    contentChars += getMessageText(message.content).length;
    ids.push(String(message.id ?? `${message.role}:${timestamp ?? ids.length}`));
  }

  if (messageCount === 0) return null;
  return {
    messageCount,
    assistantCount,
    toolResultCount,
    latestTimestamp,
    signature: `${messageCount}|${assistantCount}|${toolResultCount}|${toolUseCount}|${thinkingCount}|${assistantTextCount}|${contentChars}|${latestTimestamp ?? 'na'}|${ids.join(',')}`,
    visibleKind,
    toolUseCount,
    thinkingCount,
    assistantTextCount,
  };
}

function isMessageAfterUserTimestamp(message: RawMessage, userTimestampMs: number | null): boolean {
  if (!userTimestampMs || !message.timestamp) return true;
  return toMs(message.timestamp) >= userTimestampMs;
}

function getThinkingTextLength(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let length = 0;
  for (const block of content as ContentBlock[]) {
    if (block.type === 'thinking' && typeof block.thinking === 'string') {
      length += block.thinking.length;
    }
  }
  return length;
}

function getAssistantProgressContentLength(message: RawMessage): number {
  return Math.max(getMessageText(message.content).length, getThinkingTextLength(message.content));
}

function getStreamingDisplayText(message: RawMessage): string {
  const text = getMessageText(message.content);
  if (text.trim()) return text;
  if (!Array.isArray(message.content)) return text;
  const thinkingParts = (message.content as ContentBlock[])
    .filter((block) => block.type === 'thinking' && typeof block.thinking === 'string')
    .map((block) => block.thinking!.trim())
    .filter(Boolean);
  return thinkingParts.length > 0 ? thinkingParts.join('\n') : text;
}

function getStreamingAssistantTextLength(
  state: Pick<ChatState, 'streamingMessage' | 'streamingText'>,
): number {
  if (state.streamingMessage && typeof state.streamingMessage === 'object') {
    return getAssistantProgressContentLength(state.streamingMessage as RawMessage);
  }
  return state.streamingText?.length ?? 0;
}

/**
 * When Gateway stream events are delayed or missing, mirror in-progress assistant
 * turns from the local JSONL transcript into streaming UI state.
 */
function buildSendingUiPatchFromTranscript(
  rawMessages: RawMessage[],
  state: Pick<ChatState, 'sending' | 'lastUserMessageAt' | 'streamingMessage' | 'streamingText' | 'streamingTools' | 'pendingFinal'>,
): Partial<ChatState> | null {
  if (!state.sending) return null;

  const userTs = state.lastUserMessageAt;
  const progress = getRuntimeTranscriptProgress(rawMessages, userTs);
  if (!progress) return null;

  const patch: Partial<ChatState> = {};
  const hasLive = hasLiveStreamContent(state);

  let mergedTools = state.streamingTools;
  let longestAssistant: RawMessage | null = null;
  let longestAssistantTextLen = 0;

  for (const message of rawMessages) {
    if (!isMessageAfterUserTimestamp(message, userTs)) continue;

    const eventState = isToolResultRole(message.role) ? 'final' : 'delta';
    const toolUpdates = collectToolUpdates(message, eventState);
    if (toolUpdates.length > 0) {
      mergedTools = upsertToolStatuses(mergedTools, toolUpdates);
    }
  }

  for (const message of rawMessages) {
    if (!isMessageAfterUserTimestamp(message, userTs)) continue;
    if (message.role !== 'assistant') continue;

    const normalized = normalizeStreamingMessage(message) as RawMessage;
    const progressInfo = classifyVisibleProgress(normalized);
    if (progressInfo.kind === 'none' || progressInfo.kind === 'placeholder') continue;
    const contentLen = getAssistantProgressContentLength(normalized);
    if (contentLen > longestAssistantTextLen) {
      longestAssistantTextLen = contentLen;
      longestAssistant = normalized;
    }
  }

  const hasTerminalReply = [...rawMessages].reverse().some((message) => {
    if (!isMessageAfterUserTimestamp(message, userTs)) return false;
    return isRunTerminalAssistantMessage(message);
  });
  const concludingReply = findConcludingAssistantForActiveTurn(rawMessages, userTs);
  const hasCommittedVisibleReply = hasTerminalReply
    || (concludingReply != null && hasVisibleAssistantContent(concludingReply));

  if (hasLive) {
    if (mergedTools.length !== state.streamingTools.length
      || JSON.stringify(mergedTools) !== JSON.stringify(state.streamingTools)) {
      patch.streamingTools = mergedTools;
    }
    const currentTextLen = getStreamingAssistantTextLength(state);
    if (longestAssistant && longestAssistantTextLen > currentTextLen) {
      patch.streamingMessage = longestAssistant;
      patch.streamingText = getStreamingDisplayText(longestAssistant);
    }
    if (!hasCommittedVisibleReply && (progress.assistantCount > 0 || progress.toolResultCount > 0)) {
      patch.pendingFinal = true;
    }
    return Object.keys(patch).length > 0 ? patch : null;
  }

  if (longestAssistant) {
    const progressInfo = classifyVisibleProgress(longestAssistant);
    if (progressInfo.visible) {
      patch.streamingMessage = longestAssistant;
      patch.streamingText = getStreamingDisplayText(longestAssistant);
      if (mergedTools.length > 0) {
        patch.streamingTools = mergedTools;
      }
    }
  }

  if (!hasCommittedVisibleReply && (progress.assistantCount > 0 || progress.toolResultCount > 0)) {
    patch.pendingFinal = true;
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

function applySendingUiPatchFromTranscript(
  rawMessages: RawMessage[],
  set: (partial: Partial<ChatState> | ((state: ChatState) => Partial<ChatState>)) => void,
  get: () => ChatState,
): void {
  const patch = buildSendingUiPatchFromTranscript(rawMessages, get());
  if (patch) {
    set(patch);
  }
}

/** Extract media file refs from [media attached: <path> (<mime>) | <path>] patterns */
function extractMediaRefs(text: string): Array<{ filePath: string; mimeType: string }> {
  const refs: Array<{ filePath: string; mimeType: string }> = [];
  const blockPattern = /\[media attached:\s*([\s\S]*?)\s*\]/g;
  for (const match of text.matchAll(blockPattern)) {
    const inner = match[1].trim();
    if (!inner) continue;
    const pipeIdx = inner.lastIndexOf(' | ');
    const left = pipeIdx >= 0 ? inner.slice(0, pipeIdx) : inner;
    const rightPath = pipeIdx >= 0 ? inner.slice(pipeIdx + 3).trim() : '';
    const parenIdx = left.lastIndexOf(' (');
    const filePath = (parenIdx >= 0 ? left.slice(0, parenIdx) : left).trim();
    const mimeType = parenIdx >= 0
      ? left.slice(parenIdx + 2).replace(/\)\s*$/, '').trim()
      : 'application/octet-stream';
    if (filePath) refs.push({ filePath, mimeType });
    if (rightPath && rightPath !== filePath) refs.push({ filePath: rightPath, mimeType });
  }
  return refs;
}

/** Map common file extensions to MIME types */
function mimeFromExtension(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    // Images
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'webp': 'image/webp',
    'bmp': 'image/bmp',
    'avif': 'image/avif',
    'svg': 'image/svg+xml',
    // Documents
    'pdf': 'application/pdf',
    'doc': 'application/msword',
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'xls': 'application/vnd.ms-excel',
    'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'ppt': 'application/vnd.ms-powerpoint',
    'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'txt': 'text/plain',
    'csv': 'text/csv',
    'md': 'text/markdown',
    'rtf': 'application/rtf',
    'epub': 'application/epub+zip',
    // Archives
    'zip': 'application/zip',
    'tar': 'application/x-tar',
    'gz': 'application/gzip',
    'rar': 'application/vnd.rar',
    '7z': 'application/x-7z-compressed',
    // Audio
    'mp3': 'audio/mpeg',
    'wav': 'audio/wav',
    'ogg': 'audio/ogg',
    'aac': 'audio/aac',
    'flac': 'audio/flac',
    'm4a': 'audio/mp4',
    // Video
    'mp4': 'video/mp4',
    'mov': 'video/quicktime',
    'avi': 'video/x-msvideo',
    'mkv': 'video/x-matroska',
    'webm': 'video/webm',
    'm4v': 'video/mp4',
  };
  return map[ext] || 'application/octet-stream';
}

function isWindowsRuntime(): boolean {
  return typeof navigator !== 'undefined' && /win/i.test(navigator.platform);
}

function isPreviewableRawFilePath(filePath: string): boolean {
  if (!filePath || /[*?]/.test(filePath)) return false;
  if (isWindowsRuntime() && filePath.startsWith('/') && !filePath.startsWith('~/')) return false;
  return true;
}

/**
 * Extract raw file paths from message text.
 * Detects absolute paths (Unix: / or ~/, Windows: C:\ etc.) ending with common file extensions.
 * Handles both image and non-image files, consistent with channel push message behavior.
 */
function extractRawFilePaths(text: string): Array<{ filePath: string; mimeType: string }> {
  const refs: Array<{ filePath: string; mimeType: string }> = [];
  const seen = new Set<string>();
  const exts = 'png|jpe?g|gif|webp|bmp|avif|svg|pdf|docx?|xlsx?|pptx?|txt|csv|md|rtf|epub|zip|tar|gz|rar|7z|mp3|wav|ogg|aac|flac|m4a|mp4|mov|avi|mkv|webm|m4v';
  // Unix absolute paths (/... or ~/...) ??lookbehind rejects mid-token slashes
  // (e.g. "path/to/file.mp4", "https://example.com/file.mp4")
  const unixRegex = new RegExp(`(?<![\\w./:])((?:\\/|~\\/)[^\\s\\n"'()\\[\\],<>]*?\\.(?:${exts}))`, 'gi');
  // Windows absolute paths (C:\... D:\...) ??lookbehind rejects drive letter glued to a word
  const winRegex = new RegExp(`(?<![\\w])([A-Za-z]:\\\\[^\\s\\n"'()\\[\\],<>]*?\\.(?:${exts}))`, 'gi');
  for (const regex of [unixRegex, winRegex]) {
    let match;
    while ((match = regex.exec(text)) !== null) {
      const p = match[1];
      if (p && isPreviewableRawFilePath(p) && !seen.has(p)) {
        seen.add(p);
        refs.push({ filePath: p, mimeType: mimeFromExtension(p) });
      }
    }
  }
  return refs;
}

/**
 * Extract images from a content array (including nested tool_result content).
 * Converts them to AttachedFileMeta entries with preview set to data URL or remote URL.
 */
function extractImagesAsAttachedFiles(content: unknown): AttachedFileMeta[] {
  if (!Array.isArray(content)) return [];
  const files: AttachedFileMeta[] = [];

  for (const block of content as ContentBlock[]) {
    if (block.type === 'image') {
      // Path 1: Anthropic source-wrapped format {source: {type, media_type, data}}
      if (block.source) {
        const src = block.source;
        const mimeType = src.media_type || 'image/jpeg';

        if (src.type === 'base64' && src.data) {
          files.push({
            fileName: 'image',
            mimeType,
            fileSize: 0,
            preview: `data:${mimeType};base64,${src.data}`,
          });
        } else if (src.type === 'url' && src.url) {
          files.push({
            fileName: 'image',
            mimeType,
            fileSize: 0,
            preview: src.url,
          });
        }
      }
      // Path 2: Flat format from Gateway tool results {data, mimeType}
      else if (block.data) {
        const mimeType = block.mimeType || 'image/jpeg';
        files.push({
          fileName: 'image',
          mimeType,
          fileSize: 0,
          preview: `data:${mimeType};base64,${block.data}`,
        });
      }
    }
    // Recurse into tool_result content blocks
    if ((block.type === 'tool_result' || block.type === 'toolResult') && block.content) {
      files.push(...extractImagesAsAttachedFiles(block.content));
    }
  }
  return files;
}

/**
 * Build an AttachedFileMeta entry for a file ref, using cache if available.
 */
function makeAttachedFile(
  ref: { filePath: string; mimeType: string },
  source: AttachedFileMeta['source'] = 'message-ref',
): AttachedFileMeta {
  const cached = _imageCache.get(ref.filePath);
  if (cached) return { ...cached, filePath: ref.filePath, source };
  const fileName = attachmentFileNameFromPath(ref.filePath);
  return { fileName, mimeType: ref.mimeType, fileSize: 0, preview: null, filePath: ref.filePath, source };
}

/**
 * Extract file path from a tool call's arguments by toolCallId.
 * Searches common argument names: file_path, filePath, path, file.
 */
function getToolCallFilePath(msg: RawMessage, toolCallId: string): string | undefined {
  if (!toolCallId) return undefined;

  // Anthropic/normalized format ??toolCall blocks in content array
  const content = msg.content;
  if (Array.isArray(content)) {
    for (const block of content as ContentBlock[]) {
      if ((block.type === 'tool_use' || block.type === 'toolCall') && block.id === toolCallId) {
        const args = (block.input ?? block.arguments) as Record<string, unknown> | undefined;
        if (args) {
          const fp = args.file_path ?? args.filePath ?? args.path ?? args.file;
          if (typeof fp === 'string') return fp;
        }
      }
    }
  }

  // OpenAI format ??tool_calls array on the message itself
  const msgAny = msg as unknown as Record<string, unknown>;
  const toolCalls = msgAny.tool_calls ?? msgAny.toolCalls;
  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls as Array<Record<string, unknown>>) {
      if (tc.id !== toolCallId) continue;
      const fn = (tc.function ?? tc) as Record<string, unknown>;
      let args: Record<string, unknown> | undefined;
      try {
        args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : (fn.arguments ?? fn.input) as Record<string, unknown>;
      } catch { /* ignore */ }
      if (args) {
        const fp = args.file_path ?? args.filePath ?? args.path ?? args.file;
        if (typeof fp === 'string') return fp;
      }
    }
  }

  return undefined;
}

/**
 * Collect all tool call file paths from a message into a Map<toolCallId, filePath>.
 */
function collectToolCallPaths(msg: RawMessage, paths: Map<string, string>): void {
  const content = msg.content;
  if (Array.isArray(content)) {
    for (const block of content as ContentBlock[]) {
      if ((block.type === 'tool_use' || block.type === 'toolCall') && block.id) {
        const args = (block.input ?? block.arguments) as Record<string, unknown> | undefined;
        if (args) {
          const fp = args.file_path ?? args.filePath ?? args.path ?? args.file;
          if (typeof fp === 'string') paths.set(block.id, fp);
        }
      }
    }
  }
  const msgAny = msg as unknown as Record<string, unknown>;
  const toolCalls = msgAny.tool_calls ?? msgAny.toolCalls;
  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls as Array<Record<string, unknown>>) {
      const id = typeof tc.id === 'string' ? tc.id : '';
      if (!id) continue;
      const fn = (tc.function ?? tc) as Record<string, unknown>;
      let args: Record<string, unknown> | undefined;
      try {
        args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : (fn.arguments ?? fn.input) as Record<string, unknown>;
      } catch { /* ignore */ }
      if (args) {
        const fp = args.file_path ?? args.filePath ?? args.path ?? args.file;
        if (typeof fp === 'string') paths.set(id, fp);
      }
    }
  }
}

/**
 * Before filtering tool_result messages from history, scan them for any file/image
 * content and attach those to the immediately following assistant message.
 * This mirrors channel push message behavior where tool outputs surface files to the UI.
 * Handles:
 *   - Image content blocks (base64 / url)
 *   - [media attached: path (mime) | path] text patterns in tool result output
 *   - Raw file paths in tool result text
 */
function enrichWithToolResultFiles(messages: RawMessage[]): RawMessage[] {
  const pending: AttachedFileMeta[] = [];
  const toolCallPaths = new Map<string, string>();

  return messages.map((msg) => {
    // Track file paths from assistant tool call arguments for later matching
    if (msg.role === 'assistant') {
      collectToolCallPaths(msg, toolCallPaths);
    }

    if (isToolResultRole(msg.role)) {
      // Resolve file path from the matching tool call
      const matchedPath = msg.toolCallId ? toolCallPaths.get(msg.toolCallId) : undefined;

      // 1. Image/file content blocks in the structured content array
      const imageFiles = extractImagesAsAttachedFiles(msg.content);
      if (matchedPath) {
        for (const f of imageFiles) {
          if (!f.filePath) {
            f.filePath = matchedPath;
            f.fileName = attachmentFileNameFromPath(matchedPath);
          }
        }
      }
      pending.push(...imageFiles.map((file) => (file.source ? file : { ...file, source: 'tool-result' as const })));

      // 2. [media attached: ...] patterns in tool result text output
      const text = getMessageText(msg.content);
      if (text) {
        const mediaRefs = extractMediaRefs(text);
        const mediaRefPaths = new Set(mediaRefs.map(r => r.filePath));
        for (const ref of mediaRefs) {
          pending.push(makeAttachedFile(ref, 'tool-result'));
        }
        // 3. Raw file paths in tool result text (documents, audio, video, etc.)
        for (const ref of extractRawFilePaths(text)) {
          if (!mediaRefPaths.has(ref.filePath)) {
            pending.push(makeAttachedFile(ref, 'tool-result'));
          }
        }
      }

      return msg; // will be filtered later
    }

    if (msg.role === 'assistant' && pending.length > 0) {
      const toAttach = pending.splice(0);
      // Deduplicate against files already on the assistant message
      const existingPaths = new Set(
        (msg._attachedFiles || []).map(f => f.filePath).filter(Boolean),
      );
      const newFiles = toAttach.filter(f => !f.filePath || !existingPaths.has(f.filePath));
      if (newFiles.length === 0) return msg;
      return {
        ...msg,
        _attachedFiles: [...(msg._attachedFiles || []), ...newFiles],
      };
    }

    return msg;
  });
}

/**
 * Restore _attachedFiles for messages loaded from history.
 * Handles:
 *   1. [media attached: path (mime) | path] patterns (attachment-button flow)
 *   2. Raw image file paths typed in message text (e.g. /Users/.../image.png)
 * Uses local cache for previews when available; missing previews are loaded async.
 */
function enrichWithCachedImages(messages: RawMessage[]): RawMessage[] {
  return messages.map((msg, idx) => {
    // Only process user and assistant messages; skip if already enriched
    if ((msg.role !== 'user' && msg.role !== 'assistant') || msg._attachedFiles) return msg;
    const text = getMessageText(msg.content);

    // Path 1: [media attached: path (mime) | path] ??guaranteed format from attachment button
    const mediaRefs = extractMediaRefs(text);
    const mediaRefPaths = new Set(mediaRefs.map(r => r.filePath));

    // Path 2: Raw file paths.
    // For assistant messages: scan own text AND the nearest preceding user message text,
    // but only for non-tool-only assistant messages (i.e. the final answer turn).
    // Tool-only messages (thinking + tool calls) should not show file previews ??those
    // belong to the final answer message that comes after the tool results.
    // User messages never get raw-path previews so the image is not shown twice.
    let rawRefs: Array<{ filePath: string; mimeType: string }> = [];
    if (msg.role === 'assistant' && !isToolOnlyMessage(msg)) {
      // Own text
      rawRefs = extractRawFilePaths(text).filter(r => !mediaRefPaths.has(r.filePath));

      // Nearest preceding user message text (look back up to 5 messages)
      const seenPaths = new Set(rawRefs.map(r => r.filePath));
      for (let i = idx - 1; i >= Math.max(0, idx - 5); i--) {
        const prev = messages[i];
        if (!prev) break;
        if (prev.role === 'user') {
          const prevText = getMessageText(prev.content);
          for (const ref of extractRawFilePaths(prevText)) {
            if (!mediaRefPaths.has(ref.filePath) && !seenPaths.has(ref.filePath)) {
              seenPaths.add(ref.filePath);
              rawRefs.push(ref);
            }
          }
          break; // only use the nearest user message
        }
      }
    }

    const allRefs = [...mediaRefs, ...rawRefs];
    if (allRefs.length === 0) return msg;

    const files: AttachedFileMeta[] = allRefs.map(ref => {
      const cached = _imageCache.get(ref.filePath);
      if (cached) return { ...cached, filePath: ref.filePath, source: 'message-ref' };
      const fileName = attachmentFileNameFromPath(ref.filePath);
      return { fileName, mimeType: ref.mimeType, fileSize: 0, preview: null, filePath: ref.filePath, source: 'message-ref' };
    });
    return { ...msg, _attachedFiles: files };
  });
}

/**
 * Async: load missing previews from disk via IPC for messages that have
 * _attachedFiles with null previews. Updates messages in-place and triggers re-render.
 * Handles both [media attached: ...] patterns and raw filePath entries.
 */
async function loadMissingPreviews(messages: RawMessage[]): Promise<boolean> {
  // Collect all image paths that need previews
  const needPreview: Array<{ filePath: string; mimeType: string }> = [];
  const seenPaths = new Set<string>();

  for (const msg of messages) {
    if (!msg._attachedFiles) continue;

    // Path 1: files with explicit filePath field (raw path detection or enriched refs)
    for (const file of msg._attachedFiles) {
      const fp = file.filePath;
      if (!fp || seenPaths.has(fp)) continue;
      // Images: need preview. Non-images: need file size (for FileCard display).
      const needsLoad = file.mimeType.startsWith('image/')
        ? !file.preview
        : file.fileSize === 0;
      if (needsLoad) {
        seenPaths.add(fp);
        needPreview.push({ filePath: fp, mimeType: file.mimeType });
      }
    }

    // Path 2: [media attached: ...] patterns (legacy ??in case filePath wasn't stored)
    if (msg.role === 'user') {
      const text = getMessageText(msg.content);
      const refs = extractMediaRefs(text);
      for (let i = 0; i < refs.length; i++) {
        const file = msg._attachedFiles[i];
        const ref = refs[i];
        if (!file || !ref || seenPaths.has(ref.filePath)) continue;
        const needsLoad = ref.mimeType.startsWith('image/') ? !file.preview : file.fileSize === 0;
        if (needsLoad) {
          seenPaths.add(ref.filePath);
          needPreview.push(ref);
        }
      }
    }
  }

  if (needPreview.length === 0) return false;

  try {
    const thumbnails = await hostApiFetch<Record<string, { preview: string | null; fileSize: number }>>(
      '/api/files/thumbnails',
      {
        method: 'POST',
        body: JSON.stringify({ paths: needPreview }),
      },
    );

    let updated = false;
    for (const msg of messages) {
      if (!msg._attachedFiles) continue;

      // Update files that have filePath
      for (const file of msg._attachedFiles) {
        const fp = file.filePath;
        if (!fp) continue;
        const thumb = thumbnails[fp];
        if (thumb && (thumb.preview || thumb.fileSize)) {
          if (thumb.preview) file.preview = thumb.preview;
          if (thumb.fileSize) file.fileSize = thumb.fileSize;
          _imageCache.set(fp, { ...file });
          updated = true;
        }
      }

      // Legacy: update by index for [media attached: ...] refs
      if (msg.role === 'user') {
        const text = getMessageText(msg.content);
        const refs = extractMediaRefs(text);
        for (let i = 0; i < refs.length; i++) {
          const file = msg._attachedFiles[i];
          const ref = refs[i];
          if (!file || !ref || file.filePath) continue; // skip if already handled via filePath
          const thumb = thumbnails[ref.filePath];
          if (thumb && (thumb.preview || thumb.fileSize)) {
            if (thumb.preview) file.preview = thumb.preview;
            if (thumb.fileSize) file.fileSize = thumb.fileSize;
            _imageCache.set(ref.filePath, { ...file });
            updated = true;
          }
        }
      }
    }
    if (updated) saveImageCache(_imageCache);
    return updated;
  } catch (err) {
    console.warn('[loadMissingPreviews] Failed:', err);
    return false;
  }
}

function getCanonicalPrefixFromSessions(sessions: ChatSession[]): string | null {
  const canonical = sessions.find((s) => s.key.startsWith('agent:'))?.key;
  if (!canonical) return null;
  const parts = canonical.split(':');
  if (parts.length < 2) return null;
  return `${parts[0]}:${parts[1]}`;
}

function getAgentIdFromSessionKey(sessionKey: string): string {
  if (!sessionKey.startsWith('agent:')) return 'main';
  const parts = sessionKey.split(':');
  return parts[1] || 'main';
}

function parseSessionUpdatedAtMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return toMs(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function parseSessionRecord(record: Record<string, unknown>): ChatSession | null {
  const key = String(record.key || '');
  if (!key || key.includes('__warmup__')) return null;
  const firstUserMessagePreview = record.firstUserMessagePreview
    ? String(record.firstUserMessagePreview).replace(/\/think\s+(off|medium|high)\s+/i, '')
    : undefined;
  const rawLabel = record.label
    ? String(record.label).replace(/\/think\s+(off|medium|high)\s+/i, '')
    : undefined;

  return {
    key,
    label: firstUserMessagePreview
      || (rawLabel && !isPlaceholderSessionTitle(rawLabel) ? rawLabel : undefined),
    firstUserMessagePreview,
    displayName: record.displayName && !isPlaceholderSessionTitle(String(record.displayName))
      ? String(record.displayName)
      : undefined,
    thinkingLevel: record.thinkingLevel ? String(record.thinkingLevel) : undefined,
    model: record.model ? String(record.model) : undefined,
    updatedAt: parseSessionUpdatedAtMs(record.updatedAt),
    lastMessageAt: parseSessionUpdatedAtMs(record.lastMessageAt),
  };
}

async function loadLocalSessionSummaries(agentId = 'main'): Promise<ChatSession[]> {
  const response = await hostApiFetch<{
    success: boolean;
    sessions?: Array<Record<string, unknown>>;
    error?: string;
  }>(`/api/sessions/list-local?agentId=${encodeURIComponent(agentId)}&includePreviews=1`);

  if (!response.success || !Array.isArray(response.sessions)) {
    return [];
  }

  return response.sessions
    .map(parseSessionRecord)
    .filter((session): session is ChatSession => session != null);
}

async function loadLocalSessionSummariesForAgentIds(agentIds: string[]): Promise<ChatSession[]> {
  const mergedByKey = new Map<string, ChatSession>();
  const batches = await Promise.all(
    agentIds.map((agentId) => loadLocalSessionSummaries(agentId).catch(() => [] as ChatSession[])),
  );
  for (const batch of batches) {
    for (const session of batch) {
      mergedByKey.set(session.key, session);
    }
  }
  return [...mergedByKey.values()];
}

function mergeSessionSummariesWithLocalPreviews(
  sessions: ChatSession[],
  localSessions: ChatSession[],
): ChatSession[] {
  if (localSessions.length === 0) return sessions;
  const localByKey = new Map(localSessions.map((session) => [session.key, session]));

  return sessions.map((session) => {
    const local = localByKey.get(session.key);
    if (!local) return session;

    const localLabel = local.firstUserMessagePreview || local.label;
    return {
      ...session,
      label: localLabel || session.label,
      firstUserMessagePreview: local.firstUserMessagePreview || session.firstUserMessagePreview,
      updatedAt: session.updatedAt ?? local.updatedAt,
      lastMessageAt: local.lastMessageAt ?? session.lastMessageAt,
    };
  });
}

function getSessionLabelsFromSessions(sessions: ChatSession[]): Record<string, string> {
  return Object.fromEntries(
    sessions
      .filter((session) => session.label && !isPlaceholderSessionTitle(session.label))
      .map((session) => [session.key, session.label!]),
  );
}

async function loadCronFallbackMessages(sessionKey: string, limit = 200): Promise<RawMessage[]> {
  if (!isCronSessionKey(sessionKey)) return [];
  try {
    const response = await hostApiFetch<{ messages?: RawMessage[] }>(
      buildCronSessionHistoryPath(sessionKey, limit),
    );
    return Array.isArray(response.messages) ? response.messages : [];
  } catch (error) {
    console.warn('Failed to load cron fallback history:', error);
    return [];
  }
}

async function loadMergedCronSessionMessages(
  sessionKey: string,
  latestRunMessages: RawMessage[],
  limit = 200,
): Promise<RawMessage[]> {
  if (!isCronSessionKey(sessionKey)) return latestRunMessages;
  const aggregated = await loadCronFallbackMessages(sessionKey, limit);
  return mergeCronSessionHistory(aggregated, latestRunMessages);
}

function normalizeAgentId(value: string | undefined | null): string {
  return (value ?? '').trim().toLowerCase() || 'main';
}

function buildFallbackMainSessionKey(agentId: string): string {
  return `agent:${normalizeAgentId(agentId)}:main`;
}

function resolveMainSessionKeyForAgent(agentId: string | undefined | null): string | null {
  if (!agentId) return null;
  const normalizedAgentId = normalizeAgentId(agentId);
  const summary = useAgentsStore.getState().agents.find((agent) => agent.id === normalizedAgentId);
  return summary?.mainSessionKey || buildFallbackMainSessionKey(normalizedAgentId);
}

function ensureSessionEntry(sessions: ChatSession[], sessionKey: string): ChatSession[] {
  if (sessions.some((session) => session.key === sessionKey)) {
    return sessions;
  }
  return [...sessions, { key: sessionKey, displayName: sessionKey }];
}

/** Empty `:main` is a shared scratchpad ??promote to a dedicated session key before the first send. */
function promoteEmptyMainSessionIfNeeded(
  get: () => ChatState,
  set: (partial: Partial<ChatState> | ((state: ChatState) => Partial<ChatState>)) => void,
): string {
  const state = get();
  const { currentSessionKey, messages, sessionLastActivity, sessions } = state;
  if (!currentSessionKey.endsWith(':main')) return currentSessionKey;
  if (messages.length > 0 || sessionLastActivity[currentSessionKey]) return currentSessionKey;

  const prefix = getCanonicalPrefixFromSessionKey(currentSessionKey)
    ?? getCanonicalPrefixFromSessions(sessions)
    ?? DEFAULT_CANONICAL_PREFIX;
  const newKey = `${prefix}:session-${Date.now()}`;
  const currentWorkspaceId = useWorkspacesStore.getState().currentWorkspaceId;

  set((s) => {
    const inheritedModel = s.sessions.find((session) => session.key === currentSessionKey)?.model;
    const sessionsWithNewEntry = ensureSessionEntry(s.sessions, newKey);
    return {
      currentSessionKey: newKey,
      currentAgentId: getAgentIdFromSessionKey(newKey),
      sessions: inheritedModel
        ? sessionsWithNewEntry.map((session) => session.key === newKey ? { ...session, model: inheritedModel } : session)
        : sessionsWithNewEntry,
      sessionWorkspaceIds: currentWorkspaceId
        ? { ...s.sessionWorkspaceIds, [newKey]: currentWorkspaceId }
        : s.sessionWorkspaceIds,
    };
  });

  return newKey;
}

function clearSessionEntryFromMap<T extends Record<string, unknown>>(entries: T, sessionKey: string): T {
  return Object.fromEntries(Object.entries(entries).filter(([key]) => key !== sessionKey)) as T;
}

/** Keep chat input workspace picker aligned with the selected session's binding. */
function syncWorkspacePickerToSession(
  sessionWorkspaceIds: Record<string, string>,
  sessionKey: string,
): void {
  const boundWorkspaceId = sessionWorkspaceIds[sessionKey] ?? null;
  useWorkspacesStore.getState().setCurrentWorkspace(boundWorkspaceId);
}

function buildSessionSwitchPatch(
  state: Pick<
    ChatState,
    | 'currentSessionKey'
    | 'messages'
    | 'sessions'
    | 'sessionLabels'
    | 'sessionLastActivity'
    | 'sessionWorkspaceIds'
    | 'sessionPinnedAt'
    | 'sessionStreamingStates'
    | 'sessionReasoningModes'
    | 'reasoningMode'
    | 'activeRunId'
    | 'streamingText'
    | 'streamingMessage'
    | 'streamingTools'
    | 'pendingFinal'
    | 'lastUserMessageAt'
    | 'pendingToolImages'
    | 'runAborted'
    | 'runError'
    | 'sending'
    | 'activeTool'
    | 'sessionBackendActivity'
    | 'gatewayBackgroundActivity'
  >,
  nextSessionKey: string,
): Partial<ChatState> {
  // Only treat sessions with no history records and no activity timestamp as empty.
  // Relying solely on messages.length is unreliable because switchSession clears
  // the current messages before loadHistory runs, creating a race condition that
  // could cause sessions with real history to be incorrectly removed from the sidebar.
  const leavingEmpty = !state.currentSessionKey.endsWith(':main')
    && state.messages.length === 0
    && !state.sessionLastActivity[state.currentSessionKey]
    && !state.sessionLabels[state.currentSessionKey];

  const nextSessions = leavingEmpty
    ? state.sessions.filter((session) => session.key !== state.currentSessionKey)
    : state.sessions;

  // Save the current session's reasoning mode before switching
  const savedReasoningModes: Record<string, ReasoningMode> = {
    ...state.sessionReasoningModes,
    [state.currentSessionKey]: state.reasoningMode,
  };

  // Remove reasoning mode if leaving an empty session
  const finalReasoningModes = leavingEmpty
    ? clearSessionEntryFromMap(savedReasoningModes, state.currentSessionKey)
    : savedReasoningModes;

  persistSessionReasoningModesIfChanged(finalReasoningModes);

  // Restore the target session's reasoning mode (default to 'thinking')
  const nextReasoningMode = finalReasoningModes[nextSessionKey] ?? 'thinking';

  // Save the current session's streaming state before switching.
  // Also preserve the current visible messages snapshot so completed sessions
  // can restore immediately when switched back, even if no stream is active.
  const hasActiveStreaming = state.activeRunId || state.sending;
  const shouldSnapshotMessages = hasActiveStreaming || state.messages.length > 0;
  const leavingSnapshot = sanitizeLeavingSessionStreamingSnapshot(
    {
      activeRunId: state.activeRunId,
      streamingText: state.streamingText,
      streamingMessage: state.streamingMessage,
      streamingTools: state.streamingTools,
      pendingFinal: state.pendingFinal,
      lastUserMessageAt: state.lastUserMessageAt,
      pendingToolImages: state.pendingToolImages,
      runAborted: state.runAborted,
      runError: state.runError,
      sending: state.sending,
      activeTool: state.activeTool,
      messagesSnapshot: shouldSnapshotMessages ? [...state.messages] : [],
    },
    {
      sessionKey: state.currentSessionKey,
      backendActivity: backendActivityForSession(
        state.sessionBackendActivity,
        state.currentSessionKey,
      ),
      gatewayBackground: state.gatewayBackgroundActivity,
    },
  );
  const savedStreamingStates: Record<string, SessionStreamingState> = {
    ...state.sessionStreamingStates,
    [state.currentSessionKey]: leavingSnapshot,
  };

  // Remove streaming state if leaving an empty session that has no active stream.
  // Active streams must be preserved so background events can continue updating.
  const finalStreamingStates = leavingEmpty && !hasActiveStreaming
    ? clearSessionEntryFromMap(savedStreamingStates, state.currentSessionKey)
    : savedStreamingStates;

  // Restore the next session's streaming state (if exists)
  const nextSessionState = finalStreamingStates[nextSessionKey] || {
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

  const persistedAborted = isUserAbortedSession(nextSessionKey);
  const effectiveNextSessionState = persistedAborted
    ? {
        ...nextSessionState,
        sending: false,
        activeRunId: null,
        runAborted: true,
        pendingFinal: false,
        streamingText: '',
        streamingMessage: null,
        streamingTools: [],
        pendingToolImages: [],
        lastUserMessageAt: null,
      }
    : nextSessionState;
  const effectiveStreamingStates = persistedAborted
    ? {
        ...finalStreamingStates,
        [nextSessionKey]: effectiveNextSessionState,
      }
    : finalStreamingStates;

  return {
    currentSessionKey: nextSessionKey,
    currentAgentId: getAgentIdFromSessionKey(nextSessionKey),
    sessions: ensureSessionEntry(nextSessions, nextSessionKey),
    sessionLabels: leavingEmpty
      ? clearSessionEntryFromMap(state.sessionLabels, state.currentSessionKey)
      : state.sessionLabels,
    sessionLastActivity: leavingEmpty
      ? clearSessionEntryFromMap(state.sessionLastActivity, state.currentSessionKey)
      : state.sessionLastActivity,
    sessionWorkspaceIds: leavingEmpty
      ? clearSessionEntryFromMap(state.sessionWorkspaceIds, state.currentSessionKey)
      : state.sessionWorkspaceIds,
    sessionPinnedAt: leavingEmpty
      ? clearSessionEntryFromMap(state.sessionPinnedAt, state.currentSessionKey)
      : state.sessionPinnedAt,
    // customSessionLabels is purely user-driven persisted state; preserved
    // across switches and only pruned in `deleteSession`/`renameSession`.
    sessionStreamingStates: effectiveStreamingStates,
    // Restore messages snapshot if there's an active stream, otherwise clear for loadHistory
    messages: effectiveNextSessionState.messagesSnapshot.length > 0 ? effectiveNextSessionState.messagesSnapshot : [],
    error: null,
    // Restore streaming state from the next session
    activeRunId: effectiveNextSessionState.activeRunId,
    streamingText: effectiveNextSessionState.streamingText,
    streamingMessage: effectiveNextSessionState.streamingMessage,
    streamingTools: effectiveNextSessionState.streamingTools,
    pendingFinal: effectiveNextSessionState.pendingFinal,
    lastUserMessageAt: effectiveNextSessionState.lastUserMessageAt,
    pendingToolImages: effectiveNextSessionState.pendingToolImages,
    runAborted: effectiveNextSessionState.runAborted,
    runError: effectiveNextSessionState.runError ?? null,
    sending: effectiveNextSessionState.sending,
    loading: false,
    sessionBackendActivity: null,
    // Restore per-session reasoning mode
    sessionReasoningModes: finalReasoningModes,
    reasoningMode: nextReasoningMode,
    thinkingLevel: toThinkingLevel(nextReasoningMode),
 };
}

/**
 * Gateway events without `sessionKey` can still be for a run on a different session.
 * After a session switch we clear `activeRunId`; do not set `sending` from unattributed
 * events or we block `loadHistory` and strand the user on a blank thread.
 */
function shouldAdoptStreamingRun(
  eventSessionKey: string | null,
  runId: string,
  activeRunId: string | null,
): boolean {
  if (!runId) return false;
  if (eventSessionKey != null) return true;
  return Boolean(activeRunId && runId === activeRunId);
}

function isExecApprovalFollowupRun(runId: string): boolean {
  return runId.startsWith('exec-approval-followup:');
}

function shouldProcessCurrentSessionRunEvent(activeRunId: string | null, runId: string): boolean {
  if (!activeRunId || !runId || runId === activeRunId) return true;
  return isExecApprovalFollowupRun(runId);
}

const EMPTY_FINAL_HISTORY_RETRY_MS = 2_000;
const EMPTY_FINAL_NO_RESPONSE_ERROR =
  'Run ended without a response. The current session may have a stale active run or transcript lock. Stop the run, retry, or start a new session.';

function countAssistantOutputs(messages: RawMessage[]): number {
  return messages.filter((message) => message.role === 'assistant' && hasNonToolAssistantContent(message)).length;
}

function hasNewAssistantOutput(beforeMessages: RawMessage[], afterMessages: RawMessage[]): boolean {
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

function isDuplicateAssistantFinal(messages: RawMessage[], messageId: string, message: RawMessage): boolean {
  if (messages.some((existing) => existing.id === messageId)) return true;

  const text = getMessageText(message.content).trim();
  if (!text) return false;

  const latestUserIdx = findLatestVisibleUserIndex(messages);
  const currentTurnMessages = latestUserIdx >= 0 ? messages.slice(latestUserIdx + 1) : messages;
  return currentTurnMessages.some((existing) => (
    existing.role === 'assistant'
    && getMessageText(existing.content).trim() === text
  ));
}

function isStillConfirmingEmptyFinal(get: () => ChatState, sessionKey: string, runId: string): boolean {
  const state = get();
  return state.currentSessionKey === sessionKey
    && (!runId || !state.activeRunId || state.activeRunId === runId);
}

function hasActiveRunningTool(get: () => ChatState, sessionKey: string, runId: string): boolean {
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

function completeEmptyFinalFromHistory(
  set: (partial: Partial<ChatState>) => void,
  get: () => ChatState,
  sessionKey: string,
  runId: string,
): void {
  if (!isStillConfirmingEmptyFinal(get, sessionKey, runId)) return;
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
  });
}

async function confirmEmptyFinalWithHistory(
  set: (partial: Partial<ChatState>) => void,
  get: () => ChatState,
  runId: string,
): Promise<void> {
  const sessionKey = get().currentSessionKey;
  const beforeMessages = [...get().messages];

  set({
    streamingText: '',
    streamingMessage: null,
    pendingFinal: true,
    runError: null,
  });

  await get().loadHistory(true, { force: true });
  if (isStillConfirmingEmptyFinal(get, sessionKey, runId) && hasNewAssistantOutput(beforeMessages, get().messages)) {
    completeEmptyFinalFromHistory(set, get, sessionKey, runId);
    return;
  }

  await waitForEmptyFinalRetry();
  if (!isStillConfirmingEmptyFinal(get, sessionKey, runId)) return;

  await get().loadHistory(true, { force: true });
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

function getCanonicalPrefixFromSessionKey(sessionKey: string): string | null {
  if (!sessionKey.startsWith('agent:')) return null;
  const parts = sessionKey.split(':');
  if (parts.length < 2) return null;
  return `${parts[0]}:${parts[1]}`;
}

function isToolOnlyMessage(message: RawMessage | undefined): boolean {
  if (!message) return false;
  if (isToolResultRole(message.role)) return true;

  const msg = message as unknown as Record<string, unknown>;
  const content = message.content;

  // Check OpenAI-format tool_calls field (real-time streaming from OpenAI-compatible models)
  const toolCalls = msg.tool_calls ?? msg.toolCalls;
  const hasOpenAITools = Array.isArray(toolCalls) && toolCalls.length > 0;

  if (!Array.isArray(content)) {
    // Content is not an array ??check if there's OpenAI-format tool_calls
    if (hasOpenAITools) {
      // Has tool calls but content might be empty/string ??treat as tool-only
      // if there's no meaningful text content
      const textContent = typeof content === 'string' ? content.trim() : '';
      return textContent.length === 0;
    }
    return false;
  }

  let hasTool = hasOpenAITools;
  let hasText = false;
  let hasNonToolContent = false;

  for (const block of content as ContentBlock[]) {
    if (block.type === 'tool_use' || block.type === 'tool_result' || block.type === 'toolCall' || block.type === 'toolResult') {
      hasTool = true;
      continue;
    }
    if (block.type === 'text' && block.text && block.text.trim()) {
      hasText = true;
      continue;
    }
    // Only actual image output disqualifies a tool-only message.
    // Thinking blocks are internal reasoning that can accompany tool_use ??they
    // should NOT prevent the message from being treated as an intermediate tool step.
    if (block.type === 'image') {
      hasNonToolContent = true;
    }
  }

  return hasTool && !hasText && !hasNonToolContent;
}

function isToolResultRole(role: unknown): boolean {
  if (!role) return false;
  const normalized = String(role).toLowerCase();
  return normalized === 'toolresult' || normalized === 'tool_result';
}

function isInternalMessageText(text: string): boolean {
  const normalized = text.trim();
  if (/^(HEARTBEAT_OK|NO_REPLY)\s*$/.test(normalized)) return true;
  if (/^\[?OpenClaw heartbeat poll\]?\s*$/i.test(normalized)) return true;
  if (/^\[LYCLAW internal tool failure feedback\]/i.test(normalized)) return true;
  if (/^\[LYCLAW internal convergence directive\]/i.test(normalized)) return true;
  if (/\b(?:NO_REPLY|HEARTBEAT_OK)\b/i.test(text) && stripSilentReplyToken(text).trim().length === 0) return true;
  if (isChannelDeliveryConfirmationText(text)) return true;
  if (/^\[?OpenClaw heartbeat poll\]?\s*$/i.test(text.trim())) return true;
  // Contentless failed-turn placeholder (model request errored/timed out before
  // producing output). Hide it so retries don't stack empty "完成" bubbles.
  if (/^\[?\s*assistant turn failed before producing content\.?\s*\]?$/i.test(text.trim())) return true;
  return isRuntimeSystemInjection(text);
}

function stripSilentReplyToken(text: string): string {
  if (!text) return text;
  const trimmed = text.trim();
  if (/^(HEARTBEAT_OK|NO_REPLY)\s*$/i.test(trimmed)) return '';
  if (/^\s*(?:NO_REPLY|HEARTBEAT_OK)\b/i.test(trimmed)) return '';
  return text.replace(/(?:\r?\n|\r|\s)*\b(?:NO_REPLY|HEARTBEAT_OK)\b\s*$/i, '').trimEnd();
}

/** True for internal plumbing messages that should never be shown in the UI. */
function isInternalMessage(msg: { role?: unknown; content?: unknown }): boolean {
  if (msg.role === 'system') return true;
  const text = getMessageText(msg.content);
  if ((msg.role === 'user' || msg.role === 'assistant') && isInternalMessageText(text)) return true;
  return false;
}

/**
 * Detect runtime-injected system messages that should be hidden from the chat UI.
 * These are injected by the OpenClaw runtime as user-role messages and include:
 *   - "System (untrusted): ..." ??exec results, tool output, etc.
 *   - "An async command ... has completed" ??async completion notices
 *   - "Current time: ..." followed by nothing else ??periodic heartbeat time pings
 *   - "Handle the result internally. Do not relay it to the user" ??internal directives
 */
function isRuntimeSystemInjection(text: string): boolean {
  if (!text) return false;
  const normalized = text.trim();
  if (/^\s*System\s*\(untrusted\)\s*:/i.test(normalized)) return true;
  if (/^\s*System\s*:/i.test(normalized)) return true;
  if (isModelCommandApprovalText(normalized)) return true;
  if (
    /An async command (?:(?:you ran earlier|the user already approved) has completed|did not run)/i.test(normalized)
    && /(Do not relay it to the user unless explicitly requested|Do not run the command again|Continue the task if needed|Reply to the user in a helpful way|Explain that the command did not run)/i.test(normalized)
  ) {
    return true;
  }
  if (
    /^\s*Current time\s*:/i.test(normalized)
    && /^\s*Current time\s*:[^\n]*\/\s*\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+UTC\s*$/i.test(normalized)
  ) {
    return true;
  }
  return false;
}

function isModelCommandApprovalText(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  if (/\/approve\s+[a-z0-9_-]+/i.test(normalized) && normalized.length <= 160) return true;
  const hasApprovalIntent = /(?:需要|请).{0,12}(?:批准|准许|确认|允许).{0,12}(?:执行|运行|放行|命令|操作)/i.test(normalized)
    || /请\s*(?:批准|准许|确认|允许).{0,16}(?:初始化|生成|创建)/i.test(normalized)
    || /\b(?:approve|confirm|allow)\b.{0,24}\b(?:run|execute|command)\b/i.test(normalized);
  if (!hasApprovalIntent) return false;
  return /\/approve\s+[a-z0-9_-]+/i.test(normalized)
    || /\b(?:python3?|node|npm|pnpm|yarn|uv|uvx|dir|ls|cd|findstr|grep|Get-ChildItem|Select-String|powershell|cmd)(?:\s|$|[\\/])/i.test(normalized)
    || /[A-Za-z]:\\/.test(normalized);
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content as ContentBlock[]) {
    if (block.type === 'text' && block.text) {
      parts.push(block.text);
    }
  }
  return parts.join('\n');
}

function summarizeToolOutput(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return undefined;
  const summaryLines = lines.slice(0, 2);
  let summary = summaryLines.join(' / ');
  if (summary.length > 160) {
    summary = `${summary.slice(0, 157)}...`;
  }
  return summary;
}

function normalizeToolStatus(rawStatus: unknown, fallback: 'running' | 'completed'): ToolStatus['status'] {
  const status = typeof rawStatus === 'string' ? rawStatus.toLowerCase() : '';
  if (status === 'error' || status === 'failed') return 'error';
  if (status === 'completed' || status === 'success' || status === 'done') return 'completed';
  return fallback;
}

function parseDurationMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function extractToolUseUpdates(message: unknown): ToolStatus[] {
  if (!message || typeof message !== 'object') return [];
  const msg = message as Record<string, unknown>;
  const updates: ToolStatus[] = [];

  // Path 1: Anthropic/normalized format ??tool blocks inside content array
  const content = msg.content;
  if (Array.isArray(content)) {
    for (const block of content as ContentBlock[]) {
      if ((block.type !== 'tool_use' && block.type !== 'toolCall') || !block.name) continue;
      updates.push({
        id: block.id || block.name,
        toolCallId: block.id,
        name: block.name,
        status: 'running',
        updatedAt: Date.now(),
      });
    }
  }

  // Path 2: OpenAI format ??tool_calls array on the message itself
  if (updates.length === 0) {
    const toolCalls = msg.tool_calls ?? msg.toolCalls;
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls as Array<Record<string, unknown>>) {
        const fn = (tc.function ?? tc) as Record<string, unknown>;
        const name = typeof fn.name === 'string' ? fn.name : '';
        if (!name) continue;
        const id = typeof tc.id === 'string' ? tc.id : name;
        updates.push({
          id,
          toolCallId: typeof tc.id === 'string' ? tc.id : undefined,
          name,
          status: 'running',
          updatedAt: Date.now(),
        });
      }
    }
  }

  return updates;
}

function extractToolResultBlocks(message: unknown, eventState: string): ToolStatus[] {
  if (!message || typeof message !== 'object') return [];
  const msg = message as Record<string, unknown>;
  const content = msg.content;
  if (!Array.isArray(content)) return [];

  const updates: ToolStatus[] = [];
  for (const block of content as ContentBlock[]) {
    if (block.type !== 'tool_result' && block.type !== 'toolResult') continue;
    const outputText = extractTextFromContent(block.content ?? block.text ?? '');
    const summary = summarizeToolOutput(outputText);
    updates.push({
      id: block.id || block.name || 'tool',
      toolCallId: block.id,
      name: block.name || block.id || 'tool',
      status: normalizeToolStatus(undefined, eventState === 'delta' ? 'running' : 'completed'),
      summary,
      updatedAt: Date.now(),
    });
  }

  return updates;
}

function extractToolResultUpdate(message: unknown, eventState: string): ToolStatus | null {
  if (!message || typeof message !== 'object') return null;
  const msg = message as Record<string, unknown>;
  const role = typeof msg.role === 'string' ? msg.role.toLowerCase() : '';
  if (!isToolResultRole(role)) return null;

  const toolName = typeof msg.toolName === 'string' ? msg.toolName : (typeof msg.name === 'string' ? msg.name : '');
  const toolCallId = typeof msg.toolCallId === 'string' ? msg.toolCallId : undefined;
  const details = (msg.details && typeof msg.details === 'object') ? msg.details as Record<string, unknown> : undefined;
  const rawStatus = (msg.status ?? details?.status);
  const fallback = eventState === 'delta' ? 'running' : 'completed';
  const status = normalizeToolStatus(rawStatus, fallback);
  const durationMs = parseDurationMs(details?.durationMs ?? details?.duration ?? (msg as Record<string, unknown>).durationMs);

  const outputText = (details && typeof details.aggregated === 'string')
    ? details.aggregated
    : extractTextFromContent(msg.content);
  const summary = summarizeToolOutput(outputText) ?? summarizeToolOutput(String(details?.error ?? msg.error ?? ''));

  const name = toolName || toolCallId || 'tool';
  const id = toolCallId || name;

  return {
    id,
    toolCallId,
    name,
    status,
    durationMs,
    summary,
    updatedAt: Date.now(),
  };
}

function mergeToolStatus(existing: ToolStatus['status'], incoming: ToolStatus['status']): ToolStatus['status'] {
  const order: Record<ToolStatus['status'], number> = { running: 0, completed: 1, error: 2 };
  return order[incoming] >= order[existing] ? incoming : existing;
}

function upsertToolStatuses(current: ToolStatus[], updates: ToolStatus[]): ToolStatus[] {
  if (updates.length === 0) return current;
  const next = [...current];
  for (const update of updates) {
    const key = update.toolCallId || update.id || update.name;
    if (!key) continue;
    const index = next.findIndex((tool) => (tool.toolCallId || tool.id || tool.name) === key);
    if (index === -1) {
      next.push(update);
      continue;
    }
    const existing = next[index];
    next[index] = {
      ...existing,
      ...update,
      name: update.name || existing.name,
      status: mergeToolStatus(existing.status, update.status),
      durationMs: update.durationMs ?? existing.durationMs,
      summary: update.summary ?? existing.summary,
      updatedAt: update.updatedAt || existing.updatedAt,
    };
  }
  return next;
}

/**
 * Only treat an explicit chat.send ack timeout as recoverable.
 * Gateway stopped / Gateway not connected are hard failures that
 * should still terminate the send immediately.
 */
function isRecoverableChatSendTimeout(error: string): boolean {
  return error.includes('RPC timeout: chat.send');
}

function collectToolUpdates(message: unknown, eventState: string): ToolStatus[] {
  const updates: ToolStatus[] = [];
  const toolResultUpdate = extractToolResultUpdate(message, eventState);
  if (toolResultUpdate) updates.push(toolResultUpdate);
  updates.push(...extractToolResultBlocks(message, eventState));
  updates.push(...extractToolUseUpdates(message));
  return updates;
}

function buildConvergenceDirectiveFeedback(observation: RunawayToolObservation): string {
  return [
    '[LYCLAW internal convergence directive]',
    observation.convergenceDirective ?? '',
    '',
    `Observed risk state: ${observation.riskState}.`,
    `Observed tool calls: ${observation.toolCallCount}.`,
    `Structural inspections: ${observation.structuralInspectionCount}.`,
    `Repeated debug scripts: ${observation.repeatedDebugScriptCount}.`,
    `Repeated output patterns: ${observation.repeatedOutputPatternCount}.`,
    '',
    'This is internal runtime guidance. Continue the user task if possible, but do not reveal this control message verbatim.',
  ].join('\n');
}

function injectConvergenceDirectiveIfNeeded(observation: RunawayToolObservation): RunawayToolObservation {
  if (!observation.convergenceDirective || observation.convergenceDirectiveLevel === 'none') return observation;
  if (!shouldUpgradeConvergenceDirective(observation.injectedConvergenceDirectiveLevel, observation.convergenceDirectiveLevel)) {
    return observation;
  }

  const injectedAt = Date.now();
  const idempotencyKey = [
    'convergence-directive',
    observation.sessionKey,
    observation.runId ?? 'no-run',
    observation.convergenceDirectiveLevel,
    observation.convergenceDirectiveUpdatedAt ?? injectedAt,
  ].join(':');
  void useGatewayStore.getState().rpc(
    'chat.send',
    {
      sessionKey: observation.sessionKey,
      message: buildConvergenceDirectiveFeedback(observation),
      deliver: false,
      idempotencyKey,
    },
    120_000,
  ).catch((error) => {
    console.warn('[chat.tool-loop-observer] failed to inject convergence directive:', error);
  });

  return {
    ...observation,
    injectedConvergenceDirectiveLevel: observation.convergenceDirectiveLevel,
    injectedConvergenceDirectiveAt: injectedAt,
  };
}

function recordRunawayToolObservationForStore(
  state: ChatState,
  event: Record<string, unknown>,
  resolvedState: string,
  runId: string,
  sessionKey: string,
  toolUpdates?: ToolStatus[],
): Partial<ChatState> | null {
  const currentObservation = sessionKey === state.currentSessionKey
    ? state.runawayToolObservation
    : state.sessionRunawayToolObservations[sessionKey] ?? null;
  const observed = observeRunawayToolEvent({
    observation: currentObservation,
    event,
    resolvedState,
    runId,
    sessionKey,
    toolUpdates: toolUpdates ?? collectToolUpdates(event.message, resolvedState),
  });
  if (!observed || observed === currentObservation) return null;

  const nextObservation = injectConvergenceDirectiveIfNeeded(observed);

  return {
    runawayToolObservation: sessionKey === state.currentSessionKey ? nextObservation : state.runawayToolObservation,
    sessionRunawayToolObservations: {
      ...state.sessionRunawayToolObservations,
      [sessionKey]: nextObservation,
    },
  };
}

function hasNonToolAssistantContent(message: RawMessage | undefined): boolean {
  if (!message) return false;
  if (typeof message.content === 'string' && message.content.trim()) return true;

  const content = message.content;
  if (Array.isArray(content)) {
    for (const block of content as ContentBlock[]) {
      if (block.type === 'text' && block.text && block.text.trim()) return true;
      if (block.type === 'thinking' && block.thinking && block.thinking.trim()) return true;
      if (block.type === 'image') return true;
    }
  }

  const msg = message as unknown as Record<string, unknown>;
  if (typeof msg.text === 'string' && msg.text.trim()) return true;

  return false;
}

const USER_SECURITY_DENIAL_PATTERNS = [
  /NETWORK_ACCESS_DENIED_BY_USER/i,
  /COMMAND_EXECUTION_DENIED_BY_USER/i,
  /FILE_PATH_ACCESS_DENIED_BY_USER/i,
  /OPEN_TARGET_DENIED_BY_USER/i,
  /MCP_SERVER_ENABLE_DENIED_BY_USER/i,
  /MODEL_SECRET_DENIED_BY_USER/i,
  /Network access denied:/i,
  /Command execution denied:/i,
  /Local file path access denied by user:/i,
  /Open target denied:/i,
  /MCP server enable denied:/i,
  /Model send denied because message contains secret-like values/i,
];

function isUserSecurityDenialMessage(message: unknown): boolean {
  if (typeof message !== 'string') return false;
  return USER_SECURITY_DENIAL_PATTERNS.some((pattern) => pattern.test(message));
}

function buildSecurityCancelNotice(message: unknown): string {
  const text = typeof message === 'string' ? message : '';
  const fileMatch = text.match(/Local file path access denied by user:\s*(.+?)\s*$/i);
  if (fileMatch?.[1]) {
    return i18n.t('chat:notices.fileAccessCancelled', { path: fileMatch[1].trim() });
  }
  return i18n.t('chat:notices.securityCancelled');
}

function getRuntimeEventErrorMessage(event: Record<string, unknown>): string {
  const candidates = [
    event.errorMessage,
    event.error_message,
    event.error,
    event.message,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return truncateRunErrorMessage(candidate);
    }
    if (candidate && typeof candidate === 'object') {
      const record = candidate as Record<string, unknown>;
      const nested = record.errorMessage ?? record.error_message ?? record.error;
      if (typeof nested === 'string' && nested.trim()) {
        return truncateRunErrorMessage(nested);
      }
    }
  }

  return 'An error occurred';
}

function isTerminalAssistantErrorMessage(message: RawMessage | undefined): boolean {
  return isFailedAssistantMessage(message);
}

function getNormalizedStopReason(message: RawMessage | undefined): string | null {
  if (!message) return null;
  const msg = message as RawMessage & { stopReason?: unknown; stop_reason?: unknown };
  const stopReason = msg.stopReason ?? msg.stop_reason;
  return stopReason == null ? null : String(stopReason).toLowerCase();
}

function isToolContinuationStopReason(stopReason: string | null): boolean {
  return stopReason === 'tooluse'
    || stopReason === 'tool_use'
    || stopReason === 'tool-call'
    || stopReason === 'tool_call'
    || stopReason === 'tool-calls'
    || stopReason === 'tool_calls'
    || stopReason === 'toolcalls';
}

function getMessageErrorMessage(message: RawMessage | undefined): string {
  const msg = message as (RawMessage & { errorMessage?: unknown; error_message?: unknown; error?: unknown }) | undefined;
  const value = msg?.errorMessage ?? msg?.error_message ?? msg?.error;
  if (typeof value === 'string' && value.trim()) return value;
  const contentText = getMessageText(message?.content);
  return contentText.trim() || 'An error occurred';
}

function buildSecurityDenialState(message: string): Partial<ChatState> {
  return {
    error: null,
    runError: null,
    securityCancelNotice: buildSecurityCancelNotice(message),
    sending: false,
    activeRunId: null,
    streamingText: '',
    streamingMessage: null,
    streamingTools: [],
    pendingFinal: false,
    pendingToolImages: [],
    lastUserMessageAt: null,
  };
}

function hasToolInvocation(message: RawMessage | undefined): boolean {
  if (!message) return false;
  const msg = message as unknown as Record<string, unknown>;
  const toolCalls = msg.tool_calls ?? msg.toolCalls;
  if (Array.isArray(toolCalls) && toolCalls.length > 0) return true;

  const content = message.content;
  if (!Array.isArray(content)) return false;
  return (content as ContentBlock[]).some((block) => (
    block.type === 'tool_use'
    || block.type === 'toolCall'
    || block.type === 'tool_result'
    || block.type === 'toolResult'
  ));
}

function shouldFinalizeErrorImmediately(errorMessage: string, event: Record<string, unknown>): boolean {
  if (event.recoverable === true) return false;
  if (
    event.terminal === true
    || event.final === true
    || event.recoverable === false
    || event.nonDeliverable === true
    || event.non_deliverable === true
  ) {
    return true;
  }

  const normalized = errorMessage.toLowerCase();
  return normalized.includes('non_deliverable_terminal_turn')
    || normalized.includes('list index out of range')
    || normalized.includes('tool call stream error')
    || normalized.includes('malformed tool_call')
    || normalized.includes('model did not return tool call')
    || normalized.includes('tool_calls.arguments');
}

function isTerminalAssistantMessage(message: RawMessage | undefined): boolean {
  if (!message || message.role !== 'assistant') return false;
  if (!hasNonToolAssistantContent(message)) return false;

  // Transcript polling is observational and may catch an assistant message
  // while it is still being persisted. Only an explicit stop reason is strong
  // enough to close the active run from history.
  const normalized = getNormalizedStopReason(message);
  if (normalized == null) return false;

  return !isToolContinuationStopReason(normalized);
}

type PromptErrorRecord = {
  timestamp?: unknown;
  runId?: unknown;
  error?: unknown;
};

function getPromptErrorTimestamp(error: PromptErrorRecord): number {
  const timestamp = error.timestamp;
  if (typeof timestamp === 'number') return toMs(timestamp);
  if (typeof timestamp === 'string') {
    const parsed = Date.parse(timestamp);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function getLatestPromptErrorAfterUser(
  promptErrors: PromptErrorRecord[],
  userTimestampMs: number,
): PromptErrorRecord | null {
  const afterUser = promptErrors
    .filter((error) => {
      const errorAt = getPromptErrorTimestamp(error);
      return !userTimestampMs || !errorAt || errorAt >= userTimestampMs;
    })
    .sort((a, b) => getPromptErrorTimestamp(b) - getPromptErrorTimestamp(a));
  return afterUser[0] ?? null;
}

function isRealUserMessageForInterrupted(msg: RawMessage): boolean {
  if (msg.role !== 'user') return false;
  const content = msg.content;
  if (!Array.isArray(content)) return true;
  const blocks = content as Array<{ type?: string }>;
  return blocks.length === 0
    || !blocks.every((b) => b.type === 'tool_result' || b.type === 'toolResult');
}

function getLastRealUserSnapshot(messages: RawMessage[]): RawMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isRealUserMessageForInterrupted(messages[i])) return messages[i];
  }
  return null;
}

function userMessagesLikelySame(a: RawMessage, b: RawMessage): boolean {
  if (a.id && b.id && a.id === b.id) return true;
  const ta = normalizeComparableUserText(a.content);
  const tb = normalizeComparableUserText(b.content);
  if (ta && tb && ta === tb) return true;
  return areEquivalentAttachmentOnlyUserTexts(ta, tb);
}

/** Text/image reply only ??excludes thinking-only snapshots so we can still show ��waiting??UI. */
function hasAssistantPrimaryReplyContent(message: RawMessage | undefined): boolean {
  if (!message) return false;
  if (typeof message.content === 'string' && message.content.trim()) return true;

  const content = message.content;
  if (Array.isArray(content)) {
    for (const block of content as ContentBlock[]) {
      if (block.type === 'text' && block.text && block.text.trim()) return true;
      if (block.type === 'image') return true;
    }
  }

  const msg = message as unknown as Record<string, unknown>;
  if (typeof msg.text === 'string' && msg.text.trim()) return true;

  return false;
}

/**
 * Gateway `sessions.list` can lag behind a session the user just messaged in.
 * Keep sidebar rows for in-flight / interrupted sessions and any session we already
 * labeled or stamped with activity locally.
 */
function mergePreservedSessionsIntoGatewayList(
  dedupedSessions: ChatSession[],
  snapshot: Pick<ChatState, 'sessions' | 'sessionLabels' | 'sessionLastActivity' | 'sessionWorkspaceIds'>,
  currentSessionKey?: string,
): ChatSession[] {
  const { sessions: prevSessions, sessionLabels, sessionLastActivity, sessionWorkspaceIds } = snapshot;
  const keys = new Set(dedupedSessions.map((s) => s.key));
  const out: ChatSession[] = [...dedupedSessions];

  const addIfMissing = (key: string, displayName?: string) => {
    if (!key || keys.has(key)) return;
    keys.add(key);
    out.push({
      key,
      displayName: displayName ?? sessionLabels[key] ?? key,
    });
  };

  if (_interruptedSendSession?.sessionKey) {
    addIfMissing(_interruptedSendSession.sessionKey);
  }

  for (const s of prevSessions) {
    if (keys.has(s.key)) continue;
    if (sessionLabels[s.key] || sessionLastActivity[s.key] || sessionWorkspaceIds[s.key]) {
      addIfMissing(s.key, s.displayName);
    }
  }

  // Always preserve the session the user is currently viewing, even if it
  // has no label, activity timestamp, or workspace binding. A newly-created
  // digital-employee session enters the list as a minimal { key, displayName }
  // entry and must not be dropped by subsequent loadSessions calls that run
  // before the session is registered on the backend.
  if (currentSessionKey && !keys.has(currentSessionKey)) {
    const currentEntry = prevSessions.find((s) => s.key === currentSessionKey);
    addIfMissing(currentSessionKey, currentEntry?.displayName);
  }

  return out;
}

function resolveInterruptedSendResume(
  sessionKey: string,
  enrichedMessages: RawMessage[],
  quiet: boolean,
): {
  messages: RawMessage[];
  resumePatch?: Partial<Pick<ChatState, 'sending' | 'activeRunId' | 'lastUserMessageAt'>>;
} {
  if (quiet || !_interruptedSendSession || _interruptedSendSession.sessionKey !== sessionKey) {
    return { messages: enrichedMessages };
  }

  const pending = _interruptedSendSession;
  let working = [...enrichedMessages];

  if (pending.fallbackUserMessage) {
    const hasSame = working.some(
      (m) => m.role === 'user' && userMessagesLikelySame(m, pending.fallbackUserMessage!),
    );
    if (!hasSame) {
      working.push(pending.fallbackUserMessage);
      working.sort((a, b) => {
        const ta = a.timestamp != null ? toMs(a.timestamp as number) : 0;
        const tb = b.timestamp != null ? toMs(b.timestamp as number) : 0;
        return ta - tb;
      });
    }
  }

  const userMsTs = pending.lastUserMessageAt != null
    ? toMs(pending.lastUserMessageAt)
    : (pending.fallbackUserMessage?.timestamp != null
      ? toMs(pending.fallbackUserMessage.timestamp as number)
      : 0);

  const isAfterUserMsg = (msg: RawMessage): boolean => {
    if (!userMsTs || !msg.timestamp) return true;
    return toMs(msg.timestamp) >= userMsTs - 500;
  };

  const recentPrimaryAssistant = [...working].reverse().find((msg) => {
    if (msg.role !== 'assistant') return false;
    if (!hasAssistantPrimaryReplyContent(msg)) return false;
    return isAfterUserMsg(msg);
  });

  _interruptedSendSession = null;

  if (recentPrimaryAssistant) {
    return { messages: working };
  }

  return {
    messages: working,
    resumePatch: {
      sending: true,
      activeRunId: pending.activeRunId,
      lastUserMessageAt:
        pending.lastUserMessageAt ?? (pending.fallbackUserMessage?.timestamp != null
          ? (pending.fallbackUserMessage.timestamp as number)
          : null),
    },
  };
}

/**
 * Decide whether a runtime event finishes the run for a session the user is NOT
 * currently viewing. Mirrors the terminal cases handled inline for the current
 * session (real assistant output `final`, `aborted`, and `error`) without
 * touching the visible (current-session) streaming fields.
 */
function classifyBackgroundTermination(
  get: () => ChatState,
  eventSessionKey: string,
  event: Record<string, unknown>,
  resolvedState: string,
): { completed: boolean; aborted: boolean } {
  if (resolvedState === 'aborted') {
    return { completed: true, aborted: true };
  }
  if (resolvedState === 'error') {
    const errorMsg = String(event.errorMessage || '').toLowerCase();
    return { completed: true, aborted: errorMsg.includes('abort') };
  }
  if (resolvedState === 'final') {
    const finalMsg = event.message as RawMessage | undefined;
    if (!finalMsg) {
      // A final without a message is itself a completion signal.
      return { completed: true, aborted: false };
    }
    const normalized = normalizeStreamingMessage(finalMsg) as RawMessage;
    const text = getMessageText(normalized.content);
    const isUiHidden = Boolean(text.trim()) && isInternalMessageText(text);
    if (shouldSilentlyFinalizeRunOnAssistantFinal(normalized)) {
      const state = get();
      const messages = state.currentSessionKey === eventSessionKey
        ? state.messages
        : (state.sessionStreamingStates[eventSessionKey]?.messagesSnapshot ?? []);
      const streamingMessage = state.currentSessionKey === eventSessionKey
        ? state.streamingMessage
        : state.sessionStreamingStates[eventSessionKey]?.streamingMessage;
      if (hasOpenDelegatedBackendWork(
        messages,
        state.gatewayBackgroundActivity,
        state.sessionBackendActivity,
      )) {
        return { completed: false, aborted: false };
      }
      return { completed: true, aborted: false };
    }
    // Tool steps and silent plumbing finals do not end the run; only a real
    // assistant response does.
    if (
      !isToolResultRole(normalized.role)
      && !isToolOnlyMessage(normalized)
      && hasVisibleAssistantContent(normalized)
      && !isUiHidden
    ) {
      return { completed: true, aborted: false };
    }
    if (
      !isToolResultRole(normalized.role)
      && !isToolOnlyMessage(normalized)
      && isRunTerminalAssistantMessage(normalized)
      && !isUiHidden
    ) {
      return { completed: true, aborted: false };
    }
  }
  return { completed: false, aborted: false };
}

/**
 * Keep a background session's saved streaming state in sync when its run
 * finishes while the user is viewing a different session. Without this, the
 * stale `sending`/`activeRunId` snapshot leaves the session stuck on
 * "thinking?? forever and blocks the switch-back `loadHistory` that would
 * surface the completed answer.
 */
function finalizeBackgroundSessionRunIfCompleted(
  set: (partial: Partial<ChatState> | ((state: ChatState) => Partial<ChatState>)) => void,
  get: () => ChatState,
  eventSessionKey: string,
  event: Record<string, unknown>,
  resolvedState: string,
  runId: string,
): void {
  const prev = get().sessionStreamingStates[eventSessionKey];
  if (!prev || (!prev.sending && !prev.activeRunId)) return;
  // Ignore events from a different run than the one tracked for this session.
  if (prev.activeRunId && runId && prev.activeRunId !== runId) return;

  const { completed, aborted } = classifyBackgroundTermination(get, eventSessionKey, event, resolvedState);
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

// ���� Store ����������������������������������������������������������������������������������������������������������������

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  loading: false,
  error: null,
  runError: null,
  emptyFinalRecovery: { status: 'idle' },
  securityCancelNotice: null,
  prefilledInput: null,
  sending: false,
  aborting: false,
  activeRunId: null,
  activeTool: null,
  streamingText: '',
  streamingMessage: null,
  streamingTools: [],
  pendingFinal: false,
  lastUserMessageAt: null,
  pendingToolImages: [],
  runawayToolObservation: null,
  sessionRunawayToolObservations: {},
  runAborted: false,
  sessions: [],
  currentSessionKey: DEFAULT_SESSION_KEY,
  currentAgentId: 'main',
  sessionLabels: {},
  customSessionLabels: loadCustomSessionLabelsFromStorage(),
  sessionLastActivity: {},
  sessionWorkspaceIds: loadSessionWorkspaceIdsFromStorage(),
  sessionPinnedAt: loadSessionPinnedAtFromStorage(),
  sessionStreamingStates: {},
  sessionCompressionState: {},
  contextCompressionStatus: null,
  sessionBackendActivity: null,
  gatewayBackgroundActivity: null,
  announcedChildSessionKeys: [],
  thinkingLevel: null,
  sessionReasoningModes: loadSessionReasoningModesFromStorage(),
  reasoningMode: loadSessionReasoningModesFromStorage()[DEFAULT_SESSION_KEY] ?? loadStoredReasoningMode(),

  setReasoningMode: async (mode: ReasoningMode) => {
    const sessionKey = get().currentSessionKey;
    const snapshot = get();
    set((s) => {
      const nextModes = { ...s.sessionReasoningModes, [sessionKey]: mode };
      persistSessionReasoningModesIfChanged(nextModes);
      return {
        reasoningMode: mode,
        thinkingLevel: toThinkingLevel(mode),
        sessionReasoningModes: nextModes,
      };
    });
    // Empty scratchpads keep reasoning locally until the first send patches Gateway.
    if (!isEmptyChatScratchpad(sessionKey, snapshot)) {
      deferSessionThinkingLevelPatch(sessionKey, mode);
    }
  },

  setCurrentSessionModel: async (model: string | null) => {
    const sessionKey = get().currentSessionKey;
    const normalizedModel = model && model.trim() ? model.trim() : null;

    set((s) => {
      const sessions = ensureSessionEntry(s.sessions, sessionKey).map((session) => {
        if (session.key !== sessionKey) return session;
        if (normalizedModel) {
          return { ...session, model: normalizedModel };
        }
        const { model: _model, ...rest } = session;
        void _model;
        return rest;
      });
      return { sessions };
    });

    try {
      await patchSessionModel(sessionKey, normalizedModel);
      _pendingSessionModelPatches.delete(sessionKey);
    } catch (error) {
      deferSessionModelPatch(sessionKey, normalizedModel);
      throw error;
    }
  },

  bindCurrentSessionWorkspace: (workspaceId: string | null) => {
    set((s) => {
      const next = { ...s.sessionWorkspaceIds };
      if (!workspaceId) {
        delete next[s.currentSessionKey];
      } else {
        next[s.currentSessionKey] = workspaceId;
      }
      return { sessionWorkspaceIds: next };
    });
  },

  unbindSessionWorkspace: (sessionKey: string) => {
    set((s) => {
      if (!s.sessionWorkspaceIds[sessionKey]) return s;
      const next = { ...s.sessionWorkspaceIds };
      delete next[sessionKey];
      return { sessionWorkspaceIds: next };
    });
  },

  toggleSessionPinned: (sessionKey: string) => {
    if (!sessionKey) return;
    set((s) => {
      const next = { ...s.sessionPinnedAt };
      if (next[sessionKey]) {
        delete next[sessionKey];
      } else {
        next[sessionKey] = Date.now();
      }
      persistSessionPinnedAtToStorage(next);
      return { sessionPinnedAt: next };
    });
  },

  clearSessionWorkspaceBindings: (workspaceId: string) => {
    set((s) => ({
      sessionWorkspaceIds: Object.fromEntries(
        Object.entries(s.sessionWorkspaceIds).filter(([, wid]) => wid !== workspaceId),
      ),
    }));
  },

  // ���� Load sessions via sessions.list ����
  loadSessions: async (force = false) => {
    const now = Date.now();
    if (_loadSessionsInFlight) {
      await _loadSessionsInFlight;
      return;
    }
    if (!force && now - _lastLoadSessionsAt < SESSION_LOAD_MIN_INTERVAL_MS) {
      return;
    }

    _loadSessionsInFlight = (async () => {
      try {
        const { gatewayReady } = useGatewayStore.getState().status;

        if (gatewayReady !== true) {
          try {
            const sessions = await loadLocalSessionSummaries('main');

            if (sessions.length > 0) {
              const mergedLocal = filterUserFacingSessions(
                mergePreservedSessionsIntoGatewayList(sessions, get(), get().currentSessionKey),
              );
              
              const { currentSessionKey } = get();
              let nextSessionKey = currentSessionKey || DEFAULT_SESSION_KEY;
              if (isSubagentSessionKey(nextSessionKey)) {
                const redirected = pickUserFacingSession(mergedLocal, currentSessionKey);
                if (redirected) nextSessionKey = redirected.key;
              }
              
              // ??updatedAt ��� sessionLastActivity����ֹ�Ự������Ϊ�ջỰ
              const discoveredActivity = Object.fromEntries(
                mergedLocal
                  .map((session) => {
                    const activity = resolveSessionListActivityMs(session);
                    return activity ? [session.key, activity] as const : null;
                  })
                  .filter((entry): entry is readonly [string, number] => entry != null),
              );
              const discoveredLabels = getSessionLabelsFromSessions(mergedLocal);
              
              set((state) => ({
                sessions: mergedLocal,
                currentSessionKey: nextSessionKey,
                currentAgentId: getAgentIdFromSessionKey(nextSessionKey),
                sessionLabels: {
                  ...state.sessionLabels,
                  ...discoveredLabels,
                },
                sessionLastActivity: mergeDiscoveredSessionActivity(
                  state.sessionLastActivity,
                  discoveredActivity,
                ),
              }));

              return;
            } else {
              console.warn('[Sessions] Local read returned no sessions');
            }
          } catch (err) {
            console.warn('[Sessions] Local read failed with exception:', err);
          }
        }

        const data = await useGatewayStore.getState().rpc<Record<string, unknown>>('sessions.list', {});
        if (data) {
          const rawSessions = Array.isArray(data.sessions) ? data.sessions : [];
          const gatewaySessions = rawSessions
            .map((s: Record<string, unknown>) => parseSessionRecord(s))
            .filter((session): session is ChatSession => session != null);
          let localPreviewSessions: ChatSession[] = [];
          try {
            const previewAgentIds = collectAgentIdsFromSessionKeys(
              gatewaySessions.map((session) => session.key),
            );
            localPreviewSessions = await loadLocalSessionSummariesForAgentIds(previewAgentIds);
          } catch (error) {
            console.warn('[Sessions] Failed to load local session previews for Gateway list:', error);
          }
          const sessions = mergeSessionSummariesWithLocalPreviews(gatewaySessions, localPreviewSessions);

          const canonicalBySuffix = new Map<string, string>();
          for (const session of sessions) {
            if (!session.key.startsWith('agent:')) continue;
            const parts = session.key.split(':');
            if (parts.length < 3) continue;
            const suffix = parts.slice(2).join(':');
            if (suffix && !canonicalBySuffix.has(suffix)) {
              canonicalBySuffix.set(suffix, session.key);
            }
          }

          // Deduplicate: if both short and canonical existed, keep canonical only
          const seen = new Set<string>();
          const dedupedSessions = sessions.filter((s) => {
            if (!s.key.startsWith('agent:') && canonicalBySuffix.has(s.key)) return false;
            if (seen.has(s.key)) return false;
            seen.add(s.key);
            return true;
          });

          const mergedWithPreserved = mergePreservedSessionsIntoGatewayList(dedupedSessions, get(), get().currentSessionKey);
          const userFacingSessions = filterUserFacingSessions(mergedWithPreserved);

          const { currentSessionKey, sessions: localSessions } = get();
          let nextSessionKey = currentSessionKey || DEFAULT_SESSION_KEY;
          if (!nextSessionKey.startsWith('agent:')) {
            const canonicalMatch = canonicalBySuffix.get(nextSessionKey);
            if (canonicalMatch) {
              nextSessionKey = canonicalMatch;
            }
          }
          if (isSubagentSessionKey(nextSessionKey)) {
            const redirected = pickUserFacingSession(userFacingSessions, currentSessionKey);
            if (redirected) nextSessionKey = redirected.key;
          }
          if (!userFacingSessions.find((s) => s.key === nextSessionKey) && userFacingSessions.length > 0) {
            // Preserve only locally-created pending sessions. On initial boot the
            // default ghost key (`agent:main:main`) should yield to real history.
            const hasLocalPendingSession = localSessions.some((session) => session.key === nextSessionKey);
            const viewingEmptyScratchpad = isEmptyChatScratchpad(currentSessionKey, get());
            if (!hasLocalPendingSession && !viewingEmptyScratchpad) {
              const fallback = pickUserFacingSession(userFacingSessions);
              if (fallback) nextSessionKey = fallback.key;
            }
          }

          const sessionsWithCurrent = !userFacingSessions.find((s) => s.key === nextSessionKey) && nextSessionKey
            ? [
              ...userFacingSessions,
              { key: nextSessionKey, displayName: nextSessionKey },
            ]
            : userFacingSessions;

          if (
            currentSessionKey
            && nextSessionKey !== currentSessionKey
            && sessionsWithCurrent.some((session) => session.key === currentSessionKey)
          ) {
            nextSessionKey = currentSessionKey;
          }

          const discoveredActivity = Object.fromEntries(
            sessionsWithCurrent
              .map((session) => {
                const activity = resolveSessionListActivityMs(session);
                return activity ? [session.key, activity] as const : null;
              })
              .filter((entry): entry is readonly [string, number] => entry != null),
          );
          const discoveredLabels = getSessionLabelsFromSessions(sessionsWithCurrent);

          set((state) => ({
            sessions: sessionsWithCurrent,
            currentSessionKey: nextSessionKey,
            currentAgentId: getAgentIdFromSessionKey(nextSessionKey),
            sessionLabels: {
              ...state.sessionLabels,
              ...discoveredLabels,
            },
            sessionLastActivity: mergeDiscoveredSessionActivity(
              state.sessionLastActivity,
              discoveredActivity,
            ),
          }));

          if (currentSessionKey !== nextSessionKey) {
            void get().loadHistory();
          }
        }
      } catch (err) {
        console.warn('Failed to load sessions:', err);
      } finally {
        _lastLoadSessionsAt = Date.now();
      }
    })();

    try {
      await _loadSessionsInFlight;
    } finally {
      _loadSessionsInFlight = null;
    }
  },

  // ���� Switch session ����

  switchSession: (key: string) => {
    if (isSubagentSessionKey(key)) {
      const redirected = pickUserFacingSession(get().sessions, get().currentSessionKey);
      if (!redirected) return;
      key = redirected.key;
    }
    if (key === get().currentSessionKey) return;
    // Stop any background polling for the old session before switching.
    // This prevents the poll timer from firing after the switch and loading
    // the wrong session's history into the new session's view.
    clearHistoryPoll();
    clearSessionActivityPoll();
    const prev = get();
    if (prev.sending && prev.currentSessionKey !== key) {
      _interruptedSendSession = {
        sessionKey: prev.currentSessionKey,
        activeRunId: prev.activeRunId,
        lastUserMessageAt: prev.lastUserMessageAt,
        fallbackUserMessage: getLastRealUserSnapshot(prev.messages),
      };
    }
    set((s) => buildSessionSwitchPatch(s, key));
    syncWorkspacePickerToSession(get().sessionWorkspaceIds, key);
    void refreshSessionBackendActivity(key).then((snapshot) => {
      const latest = get();
      if (latest.currentSessionKey !== key || !snapshot) return;
      set({
        sessionBackendActivity: snapshot.session,
        gatewayBackgroundActivity: snapshot.background,
      });
      const reAdopt = buildReAdoptRunPatch(
        { ...get(), currentSessionKey: key },
        key,
        snapshot.session,
        snapshot.background,
      );
      if (reAdopt) {
        set(reAdopt);
      }
      ensureSessionBackendPolling(key, set, get);
    });
    // Always reconcile transcript after switch. messagesSnapshot is only a
    // placeholder; skipping loadHistory on active streams left stale interim
    // narrations as permanent orphan bubbles when hopping between sessions.
    void get().loadHistory(true, { force: true });
  },

  // ���� Delete session ����
  //
  // NOTE: The OpenClaw Gateway does NOT expose a sessions.delete (or equivalent)
  // RPC ??confirmed by inspecting client.ts, protocol.ts and the full codebase.
  // Deletion is therefore a local-only UI operation: the session is removed from
  // the sidebar list and its labels/activity maps are cleared.  The underlying
  // JSONL history file on disk is intentionally left intact, consistent with the
  // newSession() design that avoids sessions.reset to preserve history.

  deleteSession: async (key: string) => {
    // Soft-delete the session's JSONL transcript on disk.
    // The main process renames <suffix>.jsonl ??<suffix>.deleted.jsonl so that
    // sessions.list skips it automatically.
    try {
      const result = await hostApiFetch<{
        success: boolean;
        error?: string;
      }>('/api/sessions/delete', {
        method: 'POST',
        body: JSON.stringify({ sessionKey: key }),
      });
      if (!result.success) {
        console.warn(`[deleteSession] IPC reported failure for ${key}:`, result.error);
      }
    } catch (err) {
      console.warn(`[deleteSession] IPC call failed for ${key}:`, err);
    }

    if (_interruptedSendSession?.sessionKey === key) {
      _interruptedSendSession = null;
    }
    clearUserAbortedSession(key);

    const { currentSessionKey, sessions } = get();
    const remaining = sessions.filter((s) => s.key !== key);

    if (currentSessionKey === key) {
      // Switched away from deleted session ??pick the first remaining or create new
      const next = remaining[0];
      set((s) => {
        const nextState = next ? s.sessionStreamingStates[next.key] : null;
        const preservedMessages =
          nextState != null
          && nextState.messagesSnapshot != null
          && nextState.messagesSnapshot.length > 0
            ? nextState.messagesSnapshot
            : [];
        const nextCustomLabels = Object.fromEntries(
          Object.entries(s.customSessionLabels).filter(([k]) => k !== key),
        );
        const nextPinnedAt = Object.fromEntries(
          Object.entries(s.sessionPinnedAt).filter(([k]) => k !== key),
        );
        if (s.customSessionLabels[key]) {
          persistCustomSessionLabelsToStorage(nextCustomLabels);
        }
        if (s.sessionPinnedAt[key]) {
          persistSessionPinnedAtToStorage(nextPinnedAt);
        }
        return {
          sessions: remaining,
          sessionLabels: Object.fromEntries(Object.entries(s.sessionLabels).filter(([k]) => k !== key)),
          customSessionLabels: nextCustomLabels,
          sessionLastActivity: Object.fromEntries(Object.entries(s.sessionLastActivity).filter(([k]) => k !== key)),
          sessionWorkspaceIds: Object.fromEntries(Object.entries(s.sessionWorkspaceIds).filter(([k]) => k !== key)),
          sessionPinnedAt: nextPinnedAt,
          sessionStreamingStates: Object.fromEntries(Object.entries(s.sessionStreamingStates).filter(([k]) => k !== key)),
          sessionCompressionState: Object.fromEntries(Object.entries(s.sessionCompressionState).filter(([k]) => k !== key)),
          sessionReasoningModes: Object.fromEntries(Object.entries(s.sessionReasoningModes).filter(([k]) => k !== key)),
          // Restore messages snapshot if there's an active stream, otherwise clear for loadHistory
          messages: preservedMessages,
          error: null,
          // Restore next session's streaming state if exists
          activeRunId: nextState?.activeRunId ?? null,
          streamingText: nextState?.streamingText ?? '',
          streamingMessage: nextState?.streamingMessage ?? null,
          streamingTools: nextState?.streamingTools ?? [],
          pendingFinal: nextState?.pendingFinal ?? false,
          lastUserMessageAt: nextState?.lastUserMessageAt ?? null,
          pendingToolImages: nextState?.pendingToolImages ?? [],
          runAborted: nextState?.runAborted ?? false,
          sending: nextState?.sending ?? false,
          currentSessionKey: next?.key ?? DEFAULT_SESSION_KEY,
          currentAgentId: getAgentIdFromSessionKey(next?.key ?? DEFAULT_SESSION_KEY),
        };
      });
      if (next) {
        syncWorkspacePickerToSession(get().sessionWorkspaceIds, next.key);
        const nextState = get().sessionStreamingStates[next.key];
        // Skip loadHistory if there's an active stream to preserve streaming state
        if (!nextState?.activeRunId && !nextState?.sending) {
          get().loadHistory();
        }
      }
    } else {
      set((s) => {
        const nextCustomLabels = Object.fromEntries(
          Object.entries(s.customSessionLabels).filter(([k]) => k !== key),
        );
        const nextPinnedAt = Object.fromEntries(
          Object.entries(s.sessionPinnedAt).filter(([k]) => k !== key),
        );
        if (s.customSessionLabels[key]) {
          persistCustomSessionLabelsToStorage(nextCustomLabels);
        }
        if (s.sessionPinnedAt[key]) {
          persistSessionPinnedAtToStorage(nextPinnedAt);
        }
        return {
          sessions: remaining,
          sessionLabels: Object.fromEntries(Object.entries(s.sessionLabels).filter(([k]) => k !== key)),
          customSessionLabels: nextCustomLabels,
          sessionLastActivity: Object.fromEntries(Object.entries(s.sessionLastActivity).filter(([k]) => k !== key)),
          sessionWorkspaceIds: Object.fromEntries(Object.entries(s.sessionWorkspaceIds).filter(([k]) => k !== key)),
          sessionPinnedAt: nextPinnedAt,
          sessionStreamingStates: Object.fromEntries(Object.entries(s.sessionStreamingStates).filter(([k]) => k !== key)),
          sessionReasoningModes: Object.fromEntries(Object.entries(s.sessionReasoningModes).filter(([k]) => k !== key)),
        };
      });
    }
  },

  // ���� Rename session (persisted user-edited title) ����
  //
  // We store the override in `customSessionLabels` (mirrored to localStorage),
  // not in the JSONL transcript or `sessions.json`, so we don't interfere with
  // OpenClaw's session metadata file. The Sidebar prefers this map over the
  // discovered first-user-message preview / `sessionLabels`.

  renameSession: async (key: string, newLabel: string) => {
    if (!key) return;
    const trimmed = (newLabel ?? '').trim();
    set((s) => {
      const next: Record<string, string> = { ...s.customSessionLabels };
      if (trimmed) {
        next[key] = trimmed;
      } else {
        delete next[key];
      }
      persistCustomSessionLabelsToStorage(next);
      return { customSessionLabels: next };
    });
  },

  // ���� New session ����

  newSession: (agentId?: string) => {
    // Generate a new unique session key and switch to it.
    // NOTE: We intentionally do NOT call sessions.reset on the old session.
    // sessions.reset archives (renames) the session JSONL file, making old
    // conversation history inaccessible when the user switches back to it.
    const { currentSessionKey, messages, sessionLastActivity, sessionLabels, activeRunId, streamingText, streamingMessage, streamingTools, pendingFinal, lastUserMessageAt, pendingToolImages, runAborted, sending, reasoningMode, sessionReasoningModes } = get();
    // Only treat sessions with no history records and no activity timestamp as empty
    const leavingEmpty = !currentSessionKey.endsWith(':main')
      && messages.length === 0
      && !sessionLastActivity[currentSessionKey]
      && !sessionLabels[currentSessionKey];
    const normalizedAgentId = agentId?.trim();
    const prefix = normalizedAgentId
      ? `agent:${normalizedAgentId}`
      : DEFAULT_CANONICAL_PREFIX;
    const newKey = `${prefix}:session-${Date.now()}`;
    const newSessionEntry: ChatSession = { key: newKey, displayName: newKey };
    // Save messages snapshot if there's active streaming
    const hasActiveStreaming = activeRunId || sending;
    set((s) => {
      // Save current session's streaming state
      const nextStreamingStates: Record<string, SessionStreamingState> = {
        ...s.sessionStreamingStates,
        [currentSessionKey]: {
          activeRunId,
          streamingText,
          streamingMessage,
          streamingTools,
          pendingFinal,
          lastUserMessageAt,
          pendingToolImages,
          runAborted,
          runError: s.runError,
          sending,
          activeTool: s.activeTool,
          messagesSnapshot: hasActiveStreaming ? [...messages] : [],
        },
      };
      // Remove streaming state if leaving an empty session
      const finalStreamingStates = leavingEmpty
        ? clearSessionEntryFromMap(nextStreamingStates, currentSessionKey)
        : nextStreamingStates;

      // Save current session's reasoning mode and prepare for new session
      const nextReasoningModes: Record<string, ReasoningMode> = {
        ...s.sessionReasoningModes,
        [currentSessionKey]: reasoningMode,
      };
      const finalReasoningModes = leavingEmpty
        ? clearSessionEntryFromMap(nextReasoningModes, currentSessionKey)
        : nextReasoningModes;
      persistSessionReasoningModesIfChanged(finalReasoningModes);

      return {
        currentSessionKey: newKey,
        currentAgentId: getAgentIdFromSessionKey(newKey),
        sessions: [
          ...(leavingEmpty ? s.sessions.filter((sess) => sess.key !== currentSessionKey) : s.sessions),
          newSessionEntry,
        ],
        sessionLabels: leavingEmpty
          ? Object.fromEntries(Object.entries(s.sessionLabels).filter(([k]) => k !== currentSessionKey))
          : s.sessionLabels,
        sessionLastActivity: leavingEmpty
          ? Object.fromEntries(Object.entries(s.sessionLastActivity).filter(([k]) => k !== currentSessionKey))
          : s.sessionLastActivity,
        sessionWorkspaceIds: leavingEmpty
          ? clearSessionEntryFromMap(s.sessionWorkspaceIds, currentSessionKey)
          : s.sessionWorkspaceIds,
        sessionStreamingStates: finalStreamingStates,
        sessionReasoningModes: finalReasoningModes,
        reasoningMode: 'thinking',
        thinkingLevel: 'medium',
        messages: [],
        error: null,
        runError: null,
        // Reset streaming state for new session
        activeRunId: null,
        streamingText: '',
        streamingMessage: null,
        streamingTools: [],
        pendingFinal: false,
        lastUserMessageAt: null,
        pendingToolImages: [],
        runAborted: false,
        sending: false,
        prefilledInput: null,
      };
    });
    syncWorkspacePickerToSession(get().sessionWorkspaceIds, newKey);
    // Match switchSession: pull history for the new key immediately. Relying only on
    // Chat's useEffect can strand the UI if `loading` stayed true from a prior session
    // (effect guards on `!loading`) or if the user expects the same load path as a
    // sidebar session switch.
    void get().loadHistory();
  },

  // ���� Set prefilled input text ����

  setPrefilledInput: (text: string | null) => {
    set((s) => ({ ...s, prefilledInput: text }));
  },

  // ���� Cleanup empty session on navigate away ����

  cleanupEmptySession: () => {
    const { currentSessionKey, messages, sessionLastActivity, sessionLabels } = get();
    // Only remove non-main sessions that were never used (no messages sent).
    // This mirrors the "leavingEmpty" logic in switchSession so that creating
    // a new session and immediately navigating away doesn't leave a ghost entry
    // in the sidebar.
    // Also check sessionLastActivity and sessionLabels comprehensively to prevent
    // falsely treating sessions with history as empty due to switchSession clearing messages early.
    const isEmptyNonMain = !currentSessionKey.endsWith(':main')
      && messages.length === 0
      && !sessionLastActivity[currentSessionKey]
      && !sessionLabels[currentSessionKey];
    if (!isEmptyNonMain) return;
    set((s) => {
      const nextPinnedAt = Object.fromEntries(
        Object.entries(s.sessionPinnedAt).filter(([k]) => k !== currentSessionKey),
      );
      if (s.sessionPinnedAt[currentSessionKey]) {
        persistSessionPinnedAtToStorage(nextPinnedAt);
      }
      return {
      sessions: s.sessions.filter((sess) => sess.key !== currentSessionKey),
      sessionLabels: Object.fromEntries(
        Object.entries(s.sessionLabels).filter(([k]) => k !== currentSessionKey),
      ),
      sessionLastActivity: Object.fromEntries(
        Object.entries(s.sessionLastActivity).filter(([k]) => k !== currentSessionKey),
      ),
      sessionWorkspaceIds: Object.fromEntries(
        Object.entries(s.sessionWorkspaceIds).filter(([k]) => k !== currentSessionKey),
      ),
      sessionPinnedAt: nextPinnedAt,
      sessionStreamingStates: Object.fromEntries(
        Object.entries(s.sessionStreamingStates).filter(([k]) => k !== currentSessionKey),
      ),
      sessionCompressionState: Object.fromEntries(
        Object.entries(s.sessionCompressionState).filter(([k]) => k !== currentSessionKey),
      ),
      sessionReasoningModes: Object.fromEntries(
        Object.entries(s.sessionReasoningModes).filter(([k]) => k !== currentSessionKey),
      ),
      };
    });
  },

  // ���� Load chat history ����

  loadHistory: async (quiet = false, opts?: { afterAwaitRetry?: boolean; force?: boolean }) => {
    const afterAwaitRetry = opts?.afterAwaitRetry === true;
    const force = opts?.force === true;
    const { currentSessionKey } = get();
    const hasForegroundHistory = _foregroundHistoryLoadSeen.has(currentSessionKey);
    // After session switch we clear `sending`, but a background chat event for another
    // session can briefly set `sending` again before history loads; still load when the
    // thread is empty so the user never sees a blank panel stuck behind the guard.
    if (!quiet && get().sending && get().messages.length > 0) {
      console.info('[History] Skipped foreground history load because chat is sending', {
        sessionKey: currentSessionKey,
      });
      return;
    }
    if (!quiet && hasForegroundHistory && get().messages.length > 0) {
      console.info('[History] Skipped duplicate foreground history load', {
        sessionKey: currentSessionKey,
        messageCount: get().messages.length,
      });
      return;
    }
    const isInitialForegroundLoad = !quiet && !hasForegroundHistory;
    const historyTimeoutOverride = getStartupHistoryTimeoutOverride(isInitialForegroundLoad);
    const existingLoad = _historyLoadInFlight.get(currentSessionKey);
    if (existingLoad) {
      const previous = existingLoad;
      const stuckReleaseMs = getHistoryLoadingSafetyTimeout(isInitialForegroundLoad) + 2_000;
      await Promise.race([previous, sleep(stuckReleaseMs)]);
      if (_historyLoadInFlight.get(currentSessionKey) === previous) {
        console.warn('[History] Releasing stuck in-flight history load (await timeout)', {
          sessionKey: currentSessionKey,
        });
        _historyLoadInFlight.delete(currentSessionKey);
        if (get().currentSessionKey === currentSessionKey && get().messages.length === 0 && !afterAwaitRetry) {
          return get().loadHistory(quiet, { afterAwaitRetry: true });
        }
        return;
      }
      const discarded = _historyApplyDiscardedForKey.delete(currentSessionKey);
      if (!discarded) return;
      if (get().currentSessionKey !== currentSessionKey) return;
      if (_historyLoadInFlight.has(currentSessionKey)) return;
      if (get().messages.length > 0) return;
      if (afterAwaitRetry) return;
      return get().loadHistory(quiet, { afterAwaitRetry: true });
    }

    const lastLoadAt = _lastHistoryLoadAtBySession.get(currentSessionKey) || 0;
    if (quiet && !force && !afterAwaitRetry && Date.now() - lastLoadAt < HISTORY_LOAD_MIN_INTERVAL_MS) {
      return;
    }
    if (force && isAbortHistoryQuietPeriod()) {
      return;
    }

    let loadGeneration = 0;
    if (!quiet) {
      loadGeneration = ++_historyLoadGeneration;
      set({ loading: true, error: null });
    }

    const clearHistoryLoadingIfCurrent = () => {
      if (quiet) return;
      if (loadGeneration === _historyLoadGeneration) {
        set({ loading: false });
      }
    };

    // If the RPC never settles (hang), we must drop the in-flight entry ??otherwise
    // every later `loadHistory` for this session awaits forever (see existingLoad branch)
    // and the UI can sit empty after the safety timer cleared `loading`.
    let loadingTimedOut = false;
    let loadingSafetyTimer: ReturnType<typeof setTimeout> | null = null;

    const loadPromise = (async () => {
      const isCurrentSession = () => get().currentSessionKey === currentSessionKey;
      const getPreviewMergeKey = (message: RawMessage): string => (
        `${message.id ?? ''}|${message.role}|${message.timestamp ?? ''}|${getMessageText(message.content)}`
      );
      const mergeHydratedMessages = (
        currentMessages: RawMessage[],
        hydratedMessages: RawMessage[],
      ): RawMessage[] => {
        const hydratedFilesByKey = new Map(
          hydratedMessages
            .filter((message) => message._attachedFiles?.length)
            .map((message) => [
              getPreviewMergeKey(message),
              message._attachedFiles!.map((file) => ({ ...file })),
            ]),
        );

        return currentMessages.map((message) => {
          const attachedFiles = hydratedFilesByKey.get(getPreviewMergeKey(message));
          return attachedFiles
            ? { ...message, _attachedFiles: attachedFiles }
            : message;
        });
      };

      const applyLoadFailure = (errorMessage: string | null) => {
        if (!isCurrentSession()) return;
        set((state) => {
          const hasMessages = state.messages.length > 0;
          const hasRegisteredSession = Boolean(state.sessionLabels[currentSessionKey]);
          // Suppress RPC timeout errors for chat.history as they are transient
          // and will be retried automatically. Also suppress abort-type failures
          // that result from the user stopping the run (the in-flight history/RPC
          // request gets aborted as part of the stop).
          const shouldSuppressError = errorMessage?.includes('RPC timeout: chat.history')
            || (!!errorMessage && errorMessage.toLowerCase().includes('abort') && isWithinUserAbortWindow());
          return {
            error: !quiet && errorMessage && !shouldSuppressError ? errorMessage : state.error,
            ...(hasMessages || hasRegisteredSession ? {} : { messages: [] as RawMessage[] }),
          };
        });
        clearHistoryLoadingIfCurrent();
      };

      const applyLoadedMessages = async (
        rawMessages: RawMessage[],
        thinkingLevel: string | null,
        promptErrors: PromptErrorRecord[] = [],
      ) => {
      // Guard: if the user switched sessions while this async load was in
      // flight, discard the result to prevent overwriting the new session's
      // messages with stale data from the old session.
      if (!isCurrentSession()) return false;

      // Before filtering: attach images/files from tool_result messages to the next assistant message
      const messagesWithToolImages = enrichWithToolResultFiles(rawMessages);
      const withoutInternal = messagesWithToolImages.filter((msg) => !isToolResultRole(msg.role) && !isInternalMessage(msg));
      const filteredMessages = filterChannelOutboundEchoMessages(withoutInternal);
      // Restore file attachments for user/assistant messages (from cache + text patterns)
      const enrichedMessages = annotateDigitalEmployeeHistoryMessages(
        normalizeComplexTaskControlUserMessages(enrichWithCachedImages(filteredMessages)),
      );

      const interruptedOut = resolveInterruptedSendResume(currentSessionKey, enrichedMessages, quiet);
      if (interruptedOut.resumePatch) {
        set(interruptedOut.resumePatch);
      }
      const pipelineMessages = interruptedOut.messages;
      const finalMessages = resolveFinalMessagesWithLocalPreservation(currentSessionKey, pipelineMessages, get);

      set((state) => ({
        messages: finalMessages,
        thinkingLevel,
      }));

      const firstUserMsg = finalMessages.find((m) => m.role === 'user');
      const lastMsg = finalMessages[finalMessages.length - 1];
      let discoveredLabel: string | undefined;
      if (firstUserMsg) {
        const rawText = getMessageText(firstUserMsg.content);
        const labelText = stripGatewayUserMetadata(rawText).trim();
        if (labelText) {
          discoveredLabel = labelText.length > 50 ? `${labelText.slice(0, 50)}…` : labelText;
        }
      }
      const discoveredActivity = lastMsg?.timestamp ? toMs(lastMsg.timestamp) : undefined;
      if (discoveredLabel || discoveredActivity) {
        set((s) => ({
          ...(discoveredLabel && !s.sessionLabels[currentSessionKey]
            ? { sessionLabels: { ...s.sessionLabels, [currentSessionKey]: discoveredLabel } }
            : {}),
          ...(discoveredActivity
            ? {
              sessionLastActivity: { ...s.sessionLastActivity, [currentSessionKey]: discoveredActivity },
              sessions: s.sessions.map((session) => (
                session.key === currentSessionKey
                  ? { ...session, lastMessageAt: discoveredActivity }
                  : session
              )),
            }
            : {}),
        }));
      }

      // Async: load missing image previews from disk (updates in background)
      loadMissingPreviews(finalMessages).then((updated) => {
        if (!isCurrentSession()) return;
        if (updated) {
          set((state) => ({
            messages: mergeHydratedMessages(state.messages, finalMessages),
          }));
        }
      });
      const { pendingFinal, lastUserMessageAt, sending: isSendingNow, activeRunId: currentActiveRunId } = get();

      // Finalize only when the latest user turn has a terminal assistant reply.
      // Use the merged transcript (with optimistic user messages) — raw history
      // often still ends at the previous turn while a new send is in flight.
      const recentTerminalAssistant = findTerminalAssistantForActiveTurn(
        finalMessages,
        lastUserMessageAt,
      ) ?? findConcludingAssistantForActiveTurn(
        finalMessages,
        lastUserMessageAt,
      );

      const backendSnapshot = await refreshSessionBackendActivity(currentSessionKey);
      if (backendSnapshot) {
        set({
          sessionBackendActivity: backendSnapshot.session,
          gatewayBackgroundActivity: backendSnapshot.background,
        });
      }

      if ((isSendingNow || get().pendingFinal || get().activeRunId) && recentTerminalAssistant) {
        const canClearInput = {
          messages: finalMessages,
          lastUserMessageAt,
          backendActivity: backendSnapshot?.session ?? get().sessionBackendActivity,
          terminalMessage: recentTerminalAssistant,
          gatewayBackground: backendSnapshot?.background ?? get().gatewayBackgroundActivity,
          finalizeGraceStartedAt: getFinalizeGraceStartedAt(currentSessionKey),
        };
        if (!canClearUserTurnNow(canClearInput)) {
          if (canForceClearOnVisibleCommittedReply(canClearInput)) {
            clearHistoryPoll();
            clearErrorRecoveryTimer();
            applyClearedActiveRunForSession(set, currentSessionKey);
            ensureSessionBackendPolling(currentSessionKey, set, get);
          } else {
            if (isSendingNow) {
              applySendingUiPatchFromTranscript(rawMessages, set, get);
            }
            // Transcript already has a terminal assistant but the backend still
            // reports processing (async desync). Clear stale streaming buffers so
            // the committed reply in messages[] is visible without waiting for stop.
            if (
              recentTerminalAssistant
              && (isRunTerminalAssistantMessage(recentTerminalAssistant)
                || hasVisibleAssistantContent(recentTerminalAssistant))
            ) {
              set({
                streamingText: '',
                streamingMessage: null,
                streamingTools: [],
                pendingToolImages: [],
              });
            }
          }
        } else {
          clearHistoryPoll();
          clearErrorRecoveryTimer();
          applyClearedActiveRunForSession(set, currentSessionKey);
          ensureSessionBackendPolling(currentSessionKey, set, get);
        }
      } else if (isSendingNow) {
        applySendingUiPatchFromTranscript(rawMessages, set, get);
        // When the loaded history already ends with a visible assistant reply,
        // clear any stale streaming state so the same content does not appear
        // both as a committed message bubble and a streaming reply bubble.
        const lastMsg = finalMessages[finalMessages.length - 1];
        if (lastMsg?.role === 'assistant' && hasVisibleAssistantContent(lastMsg)) {
          set({
            streamingText: '',
            streamingMessage: null,
            streamingTools: [],
            pendingToolImages: [],
          });
        }
      }

      const latestPromptError = getLatestPromptErrorAfterUser(promptErrors, lastUserMessageAt ? toMs(lastUserMessageAt) : 0);
      if (latestPromptError) {
        const promptErrorText = typeof latestPromptError.error === 'string' ? latestPromptError.error : '';
        if (!isAbortErrorMessage(promptErrorText)) {
          const promptErrorAt = getPromptErrorTimestamp(latestPromptError);
          // `isRunTerminalAssistantMessage` 需要 stop_reason，但很多正常回复
          // 没有这个字段。增加检查任意有可见文本的 assistant 消息，
          // 只要错误之后出现了正常回复，就认为 Gateway 已恢复，不展示错误。
          const hasAssistantReplyAfterError = [...rawMessages].reverse().some((msg) => {
            if (msg.role !== 'assistant') return false;
            if (!promptErrorAt || !msg.timestamp) return false;
            if (toMs(msg.timestamp) < promptErrorAt) return false;
            return isRunTerminalAssistantMessage(msg) || hasVisibleAssistantContent(msg);
          });
          if (!hasAssistantReplyAfterError) {
            const displayError = promptErrorText
              ? resolveRunFailureErrorMessage(promptErrorText)
              : i18n.t('chat:errors.modelResponseTimeoutLong');
            clearHistoryPoll();
            clearErrorRecoveryTimer();
            set({
              error: displayError,
              runError: displayError,
              sending: false,
              activeRunId: null,
              pendingFinal: false,
              streamingText: '',
              streamingMessage: null,
              streamingTools: [],
              pendingToolImages: [],
              lastUserMessageAt: null,
              runAborted: false,
            });
          }
        }
      }
      return true;
      };

      const recordTranscriptProgress = (
        rawMessages: RawMessage[],
        _source: 'local-history' | 'gateway-history',
      ) => {
        const state = get();
        if (!state.sending) return;
        const progress = getRuntimeTranscriptProgress(rawMessages, state.lastUserMessageAt);
        if (!progress) return;

        const previousSignature = _lastRuntimeTranscriptProgressSignatureBySession.get(currentSessionKey);
        if (previousSignature !== progress.signature) {
          _lastRuntimeTranscriptProgressSignatureBySession.set(currentSessionKey, progress.signature);
          _lastChatEventAt = Date.now();
        }

        applySendingUiPatchFromTranscript(rawMessages, set, get);
      };

      try {
        const loadHistoryStartTime = Date.now();
        let data: Record<string, unknown> | null = null;
        let lastError: unknown = null;

        const { gatewayReady } = useGatewayStore.getState().status;
        // Always try OpenClaw JSONL first. Skipping local when `gatewayReady && !isInitialForegroundLoad`
        // forced revisits (e.g. old sidebar sessions) onto `chat.history` only and could stack
        // slow RPCs even though transcripts exist on disk.
        console.debug(`[History] gatewayReady = ${gatewayReady}, trying local JSONL first`, {
          sessionKey: currentSessionKey,
          isInitialForegroundLoad,
        });
        try {
            const localStart = Date.now();
            const response = await hostApiFetch<{
              success: boolean;
              messages?: RawMessage[];
              promptErrors?: PromptErrorRecord[];
              error?: string;
            }>(
              `/api/sessions/history-local?sessionKey=${encodeURIComponent(currentSessionKey)}`
            );
            console.debug(`[PERF] Local history read took ${Date.now() - localStart}ms, success: ${response.success}, messages: ${response.messages?.length || 0}`);

            if (response.success && Array.isArray(response.messages)) {
              let rawMessages = response.messages;
              if (isCronSessionKey(currentSessionKey)) {
                rawMessages = await loadMergedCronSessionMessages(currentSessionKey, rawMessages, 200);
              }
              const thinkingLevel = null;
              if (rawMessages.length === 0 && gatewayReady === true) {
                console.debug(`[History] Local history was empty for ${currentSessionKey}; falling back to Gateway RPC`);
              } else {
                console.debug(`[History] Loaded ${rawMessages.length} messages from LOCAL filesystem`);

                // Apply compression reconstruction or time decay
                const compressionState = get().sessionCompressionState?.[currentSessionKey] ?? null;
                const hasCachedCompression = compressionState && !compressionState.isTruncation
                  && rawMessages.length >= compressionState.totalMessagesAtCompression;
                const preMessages = hasCachedCompression
                  ? reconstructCompressedView(rawMessages, compressionState!)
                  : rawMessages;
                const decayResult = applyTimeDecayStrategy(preMessages, get().sessionLastActivity[currentSessionKey], hasCachedCompression ?? false);

                const applied = await applyLoadedMessages(decayResult.messages, thinkingLevel, response.promptErrors ?? []);
                if (decayResult.stats.finalCount < decayResult.stats.originalCount) {
                  console.log(`[history-time-decay] ${currentSessionKey}: ${decayResult.stats.originalCount}??{decayResult.stats.finalCount} messages, ~${decayResult.stats.estimatedTokens} tokens (${decayResult.stats.hoursAgo.toFixed(1)}h ago)`);
                }
                if (!applied) {
                  _historyApplyDiscardedForKey.add(currentSessionKey);
                }
                if (applied) {
                  recordTranscriptProgress(rawMessages, 'local-history');
                }
                if (applied && isInitialForegroundLoad) {
                  _foregroundHistoryLoadSeen.add(currentSessionKey);
                }
                console.debug(`[PERF] chat.history load COMPLETE (LOCAL), total=${Date.now() - loadHistoryStartTime}ms, messages=${rawMessages.length}`);
                return;
              }
            } else {
              console.debug(`[History] Local read failed or returned no messages, response:`, response);
            }
        } catch (localError) {
          console.debug(`[History] Local filesystem read failed with exception:`, localError);
        }

        console.debug(`[History] Attempting Gateway RPC for ${currentSessionKey}`);

        for (let attempt = 0; attempt <= CHAT_HISTORY_STARTUP_RETRY_DELAYS_MS.length; attempt += 1) {
          if (!isCurrentSession()) {
            break;
          }

          try {
            data = await useGatewayStore.getState().rpc<Record<string, unknown>>(
              'chat.history',
              { sessionKey: currentSessionKey, limit: 200 },
              historyTimeoutOverride,
            );
            lastError = null;
            break;
          } catch (error) {
            lastError = error;
          }

          if (!isCurrentSession()) {
            break;
          }

          const errorKind = classifyHistoryStartupRetryError(lastError);
          const shouldRetry = isInitialForegroundLoad
            && attempt < CHAT_HISTORY_STARTUP_RETRY_DELAYS_MS.length
            && shouldRetryStartupHistoryLoad(useGatewayStore.getState().status, errorKind);

          if (!shouldRetry) {
            break;
          }

          console.warn('[chat.history] startup retry scheduled', {
            sessionKey: currentSessionKey,
            attempt: attempt + 1,
            gatewayState: useGatewayStore.getState().status.state,
            errorKind,
            error: String(lastError),
          });
          await sleep(CHAT_HISTORY_STARTUP_RETRY_DELAYS_MS[attempt]!);
        }

        if (data) {
          let rawMessages = Array.isArray(data.messages) ? data.messages as RawMessage[] : [];
          const thinkingLevel = data.thinkingLevel ? String(data.thinkingLevel) : null;
          if (isCronSessionKey(currentSessionKey)) {
            rawMessages = await loadMergedCronSessionMessages(currentSessionKey, rawMessages, 200);
          }

          // Apply compression reconstruction or time decay
          const compressionState = get().sessionCompressionState?.[currentSessionKey] ?? null;
          const hasCachedCompression = compressionState && !compressionState.isTruncation
            && rawMessages.length >= compressionState.totalMessagesAtCompression;
          const preMessages = hasCachedCompression
            ? reconstructCompressedView(rawMessages, compressionState!)
            : rawMessages;
          const decayResult = applyTimeDecayStrategy(preMessages, get().sessionLastActivity[currentSessionKey], hasCachedCompression ?? false);

          const applied = await applyLoadedMessages(decayResult.messages, thinkingLevel);
          if (decayResult.stats.finalCount < decayResult.stats.originalCount) {
            console.log(`[history-time-decay] ${currentSessionKey}: ${decayResult.stats.originalCount}??{decayResult.stats.finalCount} messages, ~${decayResult.stats.estimatedTokens} tokens (${decayResult.stats.hoursAgo.toFixed(1)}h ago)`);
          }
          if (!applied) {
            _historyApplyDiscardedForKey.add(currentSessionKey);
          }
          if (applied) {
            recordTranscriptProgress(rawMessages, 'gateway-history');
          }
          if (applied && isInitialForegroundLoad) {
            _foregroundHistoryLoadSeen.add(currentSessionKey);
          }
        } else {
          if (isCurrentSession() && isInitialForegroundLoad && classifyHistoryStartupRetryError(lastError)) {
            console.warn('[chat.history] startup retry exhausted', {
              sessionKey: currentSessionKey,
              gatewayState: useGatewayStore.getState().status.state,
              error: String(lastError),
            });
          }

          const fallbackMessages = await loadCronFallbackMessages(currentSessionKey, 200);
          if (fallbackMessages.length > 0) {
            const applied = await applyLoadedMessages(fallbackMessages, null);
            if (!applied) {
              _historyApplyDiscardedForKey.add(currentSessionKey);
            }
            if (applied && isInitialForegroundLoad) {
              _foregroundHistoryLoadSeen.add(currentSessionKey);
            }
          } else {
            applyLoadFailure(
              (lastError instanceof Error ? lastError.message : String(lastError))
              || 'Failed to load chat history',
            );
          }
        }
      } catch (err) {
        console.warn('Failed to load chat history:', err);
        const fallbackMessages = await loadCronFallbackMessages(currentSessionKey, 200);
        if (fallbackMessages.length > 0) {
          const applied = await applyLoadedMessages(fallbackMessages, null);
          if (!applied) {
            _historyApplyDiscardedForKey.add(currentSessionKey);
          }
          if (applied && isInitialForegroundLoad) {
            _foregroundHistoryLoadSeen.add(currentSessionKey);
          }
        } else {
          applyLoadFailure(String(err));
        }
      }
    })();

    _historyLoadInFlight.set(currentSessionKey, loadPromise);
    if (!quiet) {
      loadingSafetyTimer = setTimeout(() => {
        loadingTimedOut = true;
        clearHistoryLoadingIfCurrent();
        const active = _historyLoadInFlight.get(currentSessionKey);
        if (active === loadPromise) {
          console.warn('[History] Releasing stuck in-flight history load (safety timeout)', {
            sessionKey: currentSessionKey,
          });
          _historyLoadInFlight.delete(currentSessionKey);
        }
      }, getHistoryLoadingSafetyTimeout(isInitialForegroundLoad));
    }
    try {
      await loadPromise;
    } finally {
      // Clear the safety timer on normal completion
      if (loadingSafetyTimer) clearTimeout(loadingSafetyTimer);
      if (!loadingTimedOut) {
        // Only update load time if we actually didn't time out
        _lastHistoryLoadAtBySession.set(currentSessionKey, Date.now());
      }
      
      const active = _historyLoadInFlight.get(currentSessionKey);
      if (active === loadPromise) {
        _historyLoadInFlight.delete(currentSessionKey);
      }

      clearHistoryLoadingIfCurrent();
    }
  },

  // ���� Send message ����

  sendMessage: async (
    text: string,
    attachments?: Array<{ fileName: string; mimeType: string; fileSize: number; stagedPath: string; preview: string | null }>,
    targetAgentId?: string | null,
    options?: import('./chat/send-options').SendMessageOptions,
  ) => {
    let _deIsDigital = false;
    let _deAgentId = targetAgentId;
    let _deDisplayName: string | null = null;
    if (targetAgentId) {
      // LYClaw rule: @agent in the chat composer is currently limited to
      // digital employees. The target executes in this session via chat.send
      // with executeAsAgentId; the renderer must not switch sessions or call
      // sessions_spawn.
      console.info('[agent-mention] resolving digital employee mention', {
        agentId: targetAgentId,
      });
      const targetAgentSummary = useAgentsStore.getState().agents.find((agent) => agent.id === targetAgentId);
      if (targetAgentSummary?.isDigitalEmployee === true) {
        _deIsDigital = true;
        _deAgentId = null;
        _deDisplayName = targetAgentSummary.name || targetAgentId;
        console.info('[digital-employee] resolved from agent snapshot', {
          agentId: targetAgentId,
          instanceId: targetAgentSummary.digitalEmployeeInstanceId ?? null,
        });
      }
      try {
        const checkResult = await hostApiFetch<{
          success: boolean;
          isDigitalEmployee: boolean;
          name?: string | null;
        }>(
          `/api/agents/is-digital-employee?agentId=${encodeURIComponent(targetAgentId)}`
        );
        if (checkResult.success && checkResult.isDigitalEmployee) {
          _deIsDigital = true;
          _deAgentId = null;
          _deDisplayName = (typeof checkResult.name === 'string' && checkResult.name.trim())
            ? checkResult.name.trim()
            : (_deDisplayName || targetAgentId);
          console.info('[digital-employee] resolved mention to current-session execution', {
            agentId: targetAgentId,
            displayName: _deDisplayName,
          });
        }
      } catch {
        console.info('[digital-employee] lookup skipped or failed', {
          agentId: targetAgentId,
        });
      }
      if (!_deIsDigital) {
        set({ error: `@${targetAgentId} 的数字员工未安装或不可用，@agent 仅支持数字员工`, sending: false });
        return;
      }
    }
    // When entering a digital employee session via the "使用" button (newSession),
    // targetAgentId is not set because the user didn't @mention. Auto-detect the
    // digital employee from the current session key so that executeAsAgentId is
    // always passed to chat.send, ensuring skills/MCP isolation.
    if (!_deIsDigital) {
      const currentAgentId = get().currentAgentId;
      if (currentAgentId && currentAgentId !== 'main') {
        const agentSummary = useAgentsStore.getState().agents.find(
          (agent) => agent.id === currentAgentId && agent.isDigitalEmployee,
        );
        if (agentSummary) {
          _deIsDigital = true;
          _deAgentId = null;
          _deDisplayName = agentSummary.name || currentAgentId;
          console.info('[digital-employee] auto-resolved from session agent', {
            agentId: currentAgentId,
            sessionKey: get().currentSessionKey,
          });
        }
      }
    }
    // Resolve the effective target agent ID: prefer explicit @mention parameter,
    // fall back to the current session's agent ID when auto-detected as digital employee.
    const _resolvedTargetAgentId = targetAgentId ?? (_deIsDigital ? get().currentAgentId : null);
    const trimmed = text.trim();
    if (!trimmed && (!attachments || attachments.length === 0)) return;
    const suppressOptimisticUserMessage = _suppressNextOptimisticUserMessage;
    _suppressNextOptimisticUserMessage = false;

    clearAbortedChatRuns();
    set({ emptyFinalRecovery: { status: 'idle' } });

    const targetSessionKey = resolveMainSessionKeyForAgent(_deAgentId) ?? get().currentSessionKey;

    if (targetSessionKey !== get().currentSessionKey) {
      set((s) => buildSessionSwitchPatch(s, targetSessionKey));
      syncWorkspacePickerToSession(get().sessionWorkspaceIds, targetSessionKey);
      await get().loadHistory(true);
    }

    let currentSessionKey = get().currentSessionKey;
    clearUserAbortedSession(currentSessionKey);

    const preSendActivity = await refreshSessionBackendActivity(currentSessionKey);
    if (preSendActivity?.session.hasTrackedUserRun) {
      if (get().sending || get().activeRunId) {
        return;
      }
      abortGatewayRun(currentSessionKey);
      await sleep(250);
      const afterAbortActivity = await refreshSessionBackendActivity(currentSessionKey);
      if (afterAbortActivity?.session.hasTrackedUserRun) {
        set({ error: i18n.t('chat:errors.backendRunStopped'), sending: false });
        return;
      }
    }

    const reasoningMode = get().reasoningMode;
    const hasMedia = Boolean(attachments && attachments.length > 0);
    const reasoningDecision = getReasoningDecision(trimmed, reasoningMode, hasMedia);
    const effectiveReasoningMode = reasoningDecision.effectiveMode;
    const { needsPatch } = applySessionThinkingLevelInBackground(currentSessionKey, reasoningMode, set);
    if (effectiveReasoningMode !== reasoningMode) {
      console.info('[chat.latency] using fast reasoning for input', {
        selectedReasoningMode: reasoningMode,
        effectiveReasoningMode,
        reason: reasoningDecision.reason,
        rule: reasoningDecision.rule,
        confidence: reasoningDecision.confidence,
        messageLength: trimmed.length,
        hasMedia,
      });
    }

    // Get current workspace path from workspaces store
    let workspaceContext = '';
    const currentWorkspacePath = useWorkspacesStore.getState().currentWorkspacePath;
    if (currentWorkspacePath) {
      workspaceContext = `\n\n[Working Directory: ${currentWorkspacePath}]`;
    }
    const attachmentCount = attachments?.length ?? 0;
    const originalRuntimeMessage = trimmed || (attachmentCount > 0 ? 'Process the attached file(s).' : '');
    const taskKind = detectTaskWorkflowKind(originalRuntimeMessage, attachments ?? []);
    const convergenceSystemPrompt = buildInitialConvergenceSystemPrompt(taskKind);
    const isInternalStagedExecution = trimmed.includes(COMPLEX_TASK_EXECUTION_MARKER);

    if (!isInternalStagedExecution && !_deIsDigital) {
      currentSessionKey = promoteEmptyMainSessionIfNeeded(get, set);
    }

    const usePlanningPhase = shouldUseComplexTaskPlanning(originalRuntimeMessage, attachmentCount);
    const runtimeMessage = usePlanningPhase
      ? buildComplexTaskPlanningRequest(originalRuntimeMessage)
      : withComplexTaskExecutionGuide(originalRuntimeMessage, attachmentCount);
    if (usePlanningPhase) {
      _pendingComplexTaskPlans.set(currentSessionKey, {
        originalMessage: originalRuntimeMessage,
        workspaceContext,
        reasoningMode,
        attachmentCount,
        planningRunId: null,
      });
    } else {
      _pendingComplexTaskPlans.delete(currentSessionKey);
    }

    // Add user message optimistically (WITHOUT workspace context for display)
    const nowMs = Date.now();
    const userMsg: RawMessage = {
      role: 'user',
      content: trimmed || (attachments?.length ? '(file attached)' : ''),
      timestamp: nowMs / 1000,
      id: crypto.randomUUID(),
      _agentMention: _resolvedTargetAgentId || void 0,
      _agentMentionName: _deDisplayName || _resolvedTargetAgentId || void 0,
      _attachedFiles: attachments?.map(a => ({
        fileName: a.fileName,
        mimeType: a.mimeType,
        fileSize: a.fileSize,
        preview: a.preview,
        filePath: a.stagedPath,
      })),
    };

    // Save send params for potential silent retry
    clearPendingSilentRetry();
    _lastSendParams = { text, attachments, _resolvedTargetAgentId };
    _retriedRunIds = new Set();

    const contextGuard = await prepareContextBeforeSend({
      sessionKey: currentSessionKey,
      messages: get().messages,
      pendingUserMessage: userMsg,
      runtimeMessage,
      workspaceContext,
      isInternalStagedExecution,
      persistedCompressionState: get().sessionCompressionState?.[currentSessionKey] ?? null,
    });

    if (contextGuard.error) {
      set({ error: contextGuard.errorMessage ?? String(contextGuard.error), sending: false });
      return;
    }



    const isFirstMessage = !get().messages.some((m) => m.role === 'user');
    const truncated = trimmed.length > 50 ? `${trimmed.slice(0, 50)}…` : trimmed;
    const shouldSetLabel = !isInternalStagedExecution
      && isFirstMessage
      && Boolean(trimmed)
      && !get().sessionLabels[currentSessionKey];
    const selectedWorkspaceId = useWorkspacesStore.getState().currentWorkspaceId;

    set((s) => {
      const boundWorkspaceId = s.sessionWorkspaceIds[currentSessionKey] ?? selectedWorkspaceId ?? null;
      const nextMessages = (isInternalStagedExecution || suppressOptimisticUserMessage)
        ? s.messages
        : dedupeEquivalentAttachmentUserMessages([...s.messages, userMsg]);
      const prevStream = s.sessionStreamingStates[currentSessionKey] ?? createEmptySessionStreamingState();
      const runawayToolObservation = createRunawayToolObservation({
        sessionKey: currentSessionKey,
        taskKind,
        initialStrategyInjected: Boolean(convergenceSystemPrompt),
        now: nowMs,
      });
      return {
        messages: nextMessages,
        sending: true,
        error: null,
        streamingText: '',
        streamingMessage: null,
        streamingTools: [],
        activeTool: null,
        pendingFinal: false,
        lastUserMessageAt: nowMs,
        pendingToolImages: [],
        runawayToolObservation,
        sessionRunawayToolObservations: {
          ...s.sessionRunawayToolObservations,
          [currentSessionKey]: runawayToolObservation,
        },
        isFirstMessageEver: _isFirstMessageEver, // Store flag in state for UI access
        runAborted: false,
        runError: null,
        activeRunId: null,
        sessions: ensureSessionEntry(s.sessions, currentSessionKey).map((session) => (
          session.key === currentSessionKey
            ? { ...session, lastMessageAt: nowMs }
            : session
        )),
        sessionLabels: shouldSetLabel
          ? { ...s.sessionLabels, [currentSessionKey]: truncated }
          : s.sessionLabels,
        sessionLastActivity: { ...s.sessionLastActivity, [currentSessionKey]: nowMs },
        sessionWorkspaceIds: boundWorkspaceId
          ? { ...s.sessionWorkspaceIds, [currentSessionKey]: boundWorkspaceId }
          : s.sessionWorkspaceIds,
        sessionStreamingStates: {
          ...s.sessionStreamingStates,
          [currentSessionKey]: {
            ...prevStream,
            activeRunId: null,
            activeTool: null,
            streamingText: '',
            streamingMessage: null,
            streamingTools: [],
            pendingFinal: false,
            pendingToolImages: [],
            messagesSnapshot: nextMessages,
            sending: true,
            lastUserMessageAt: nowMs,
            runAborted: false,
            runError: null,
          },
        },
      };
    });

    // Mark that first message has been sent (for the entire app lifecycle)
    if (_isFirstMessageEver && !isInternalStagedExecution) {
      markFirstMessageSent();
    }

    // Start the local transcript fallback and safety timeout IMMEDIATELY (before the
    // RPC await) because the gateway's chat.send RPC may block until the
    // entire agentic conversation finishes ??the poll must run in parallel.
    _lastChatEventAt = Date.now();
    clearHistoryPoll();
    clearErrorRecoveryTimer();
    _lastRuntimeTranscriptProgressSignatureBySession.delete(currentSessionKey);
    startActiveSendHistoryFallback(currentSessionKey);
    ensureSessionBackendPolling(currentSessionKey, set, get);

    const SAFETY_TIMEOUT_MS = 15 * 60_000;
    // Removed polling mechanism to prevent duplicate user messages.
    // UI updates now rely solely on Gateway event pushes.

    const PENDING_FINAL_HISTORY_REFRESH_MS = 45_000;
    const PENDING_FINAL_HARD_TIMEOUT_MS = 12 * 60_000;
    const STREAMING_STALE_HISTORY_REFRESH_MS = 30_000;
    const STREAMING_STALE_HARD_TIMEOUT_MS = 150_000;
    let lastPendingFinalHistoryRefreshAt = 0;
    let lastStreamingHistoryRefreshAt = 0;
    const checkStuck = () => {
      void (async () => {
        const state = get();
        if (!state.sending) return;
        const idleMs = Date.now() - _lastChatEventAt;
        const hasRunningTools = state.streamingTools.some((tool) => tool.status === 'running');
        const backendSnapshot = await refreshSessionBackendActivity(currentSessionKey);
        if (backendSnapshot) {
          set({
            sessionBackendActivity: backendSnapshot.session,
            gatewayBackgroundActivity: backendSnapshot.background,
          });
        }
        const backendActivity = backendSnapshot?.session ?? get().sessionBackendActivity;
        const gatewayBackground = backendSnapshot?.background ?? get().gatewayBackgroundActivity;
        const backendStillActive = backendActivity && !shouldForceAbortStuckRun(
          backendActivity,
          gatewayBackground,
          get().messages,
        );

        if (hasRunningTools && idleMs >= TOOL_EXECUTION_STALE_MS) {
          if (backendStillActive) {
            setTimeout(checkStuck, 10_000);
            return;
          }
          clearHistoryPoll();
          clearSessionActivityPoll();
          abortGatewayRun(currentSessionKey);
          _pendingComplexTaskPlans.delete(currentSessionKey);
          console.warn('[chat.safety-timeout] 工具执行长时间无响应，已自动停止本次任务', { sessionKey: currentSessionKey });
          set({
            streamingText: '',
            streamingMessage: null,
            streamingTools: [],
            sending: false,
            activeRunId: null,
            pendingFinal: false,
            pendingToolImages: [],
            lastUserMessageAt: null,
          });
          return;
        }

        if (state.streamingMessage || state.streamingText) {
          if (idleMs < STREAMING_STALE_HISTORY_REFRESH_MS) {
            setTimeout(checkStuck, 10_000);
            return;
          }
          if (Date.now() - lastStreamingHistoryRefreshAt >= STREAMING_STALE_HISTORY_REFRESH_MS) {
            lastStreamingHistoryRefreshAt = Date.now();
            void state.loadHistory(true, { force: true });
          }
          if (idleMs >= STREAMING_STALE_HARD_TIMEOUT_MS) {
            if (backendStillActive) {
              setTimeout(checkStuck, 10_000);
              return;
            }
            const currentStream = get().streamingMessage as RawMessage | null;
            const streamSnapshot = snapshotStreamingAssistantMessage(
              currentStream,
              get().messages,
              `stale-${state.activeRunId || Date.now()}`,
            );
            clearHistoryPoll();
            clearSessionActivityPoll();
            abortGatewayRun(currentSessionKey);
            _pendingComplexTaskPlans.delete(currentSessionKey);
            set((s) => ({
              messages: streamSnapshot.length > 0 ? [...s.messages, ...streamSnapshot] : s.messages,
              error: i18n.t('chat:errors.modelResponseTimeoutLong'),
              streamingText: '',
              streamingMessage: null,
              streamingTools: [],
              sending: false,
              activeRunId: null,
              pendingFinal: false,
              pendingToolImages: [],
              lastUserMessageAt: null,
            }));
            return;
          }
          setTimeout(checkStuck, 10_000);
          return;
        }

        if (hasRunningTools) {
          setTimeout(checkStuck, 10_000);
          return;
        }

        if (state.pendingFinal) {
          if (idleMs >= PENDING_FINAL_HISTORY_REFRESH_MS && Date.now() - lastPendingFinalHistoryRefreshAt >= PENDING_FINAL_HISTORY_REFRESH_MS) {
            lastPendingFinalHistoryRefreshAt = Date.now();
            void state.loadHistory(true);
          }
          if (idleMs >= PENDING_FINAL_HARD_TIMEOUT_MS) {
            if (backendStillActive) {
              setTimeout(checkStuck, 10_000);
              return;
            }
            clearHistoryPoll();
            clearSessionActivityPoll();
            abortGatewayRun(currentSessionKey);
            _pendingComplexTaskPlans.delete(currentSessionKey);
            set({
              error: i18n.t('chat:errors.modelResponseTimeoutLong'),
              sending: false,
              activeRunId: null,
              pendingFinal: false,
              lastUserMessageAt: null,
            });
            return;
          }
          setTimeout(checkStuck, 10_000);
          return;
        }
        if (Date.now() - _lastChatEventAt < SAFETY_TIMEOUT_MS) {
          setTimeout(checkStuck, 10_000);
          return;
        }
        if (backendStillActive) {
          setTimeout(checkStuck, 10_000);
          return;
        }
        clearHistoryPoll();
        clearSessionActivityPoll();
        abortGatewayRun(currentSessionKey);
        _pendingComplexTaskPlans.delete(currentSessionKey);
        set({
          error: i18n.t('chat:errors.modelResponseTimeout'),
          sending: false,
          activeRunId: null,
          lastUserMessageAt: null,
        });
      })();
    };
    setTimeout(checkStuck, 30_000);

    const idempotencyKey = crypto.randomUUID();
    if (_deIsDigital && _resolvedTargetAgentId) {
      _digitalEmployeeRuns.set(idempotencyKey, {
        agentId: _resolvedTargetAgentId,
        name: _deDisplayName || _resolvedTargetAgentId,
      });
    }
    try {
      if (hasMedia) {
        console.log('[sendMessage] Media paths:', attachments!.map(a => a.stagedPath));
      }

      // Cache image attachments BEFORE the IPC call to avoid race condition:
      // history may reload (via Gateway event) before the RPC returns.
      // Keyed by staged file path which appears in [media attached: <path> ...].
      if (hasMedia && attachments) {
        for (const a of attachments) {
          _imageCache.set(a.stagedPath, {
            fileName: a.fileName,
            mimeType: a.mimeType,
            fileSize: a.fileSize,
            preview: a.preview,
          });
        }
        saveImageCache(_imageCache);
      }

      let result: { success: boolean; result?: { runId?: string }; error?: string };

      // Longer timeout for chat sends to tolerate high-latency networks (avoids connect error)
      const CHAT_SEND_TIMEOUT_MS = 120_000;
      const messageForGateway = withThinkingDirective(
        runtimeMessage + (_deIsDigital ? '' : workspaceContext),
        effectiveReasoningMode,
      );
      const executeAsParams = _deIsDigital && _resolvedTargetAgentId
        ? {
          executeAsAgentId: _resolvedTargetAgentId,
          executedByAgentName: _deDisplayName || _resolvedTargetAgentId,
        }
        : {};
      const skillFilter = options?.skillFilter?.map((name) => name.trim()).filter(Boolean);

      if (hasMedia) {
        result = await hostApiFetch<{ success: boolean; result?: { runId?: string }; error?: string }>(
          '/api/chat/send-with-media',
          {
            method: 'POST',
            body: JSON.stringify({
              sessionKey: currentSessionKey,
              message: messageForGateway,
              deliver: false,
              idempotencyKey,
              extraSystemPrompt: convergenceSystemPrompt ?? undefined,
              ...executeAsParams,
              ...(skillFilter?.length ? { skillFilter } : {}),
              media: (attachments ?? []).map((a) => ({
                filePath: a.stagedPath,
                mimeType: a.mimeType,
                fileName: a.fileName,
              })),
            }),
          },
        );
      } else {
        const chatSendParams: Record<string, unknown> = {
          sessionKey: currentSessionKey,
          message: messageForGateway,
          deliver: false,
          idempotencyKey,
          extraSystemPrompt: convergenceSystemPrompt ?? undefined,
          ...executeAsParams,
          ...(skillFilter?.length ? { skillFilter } : {}),
        };
        const rpcResult = await useGatewayStore.getState().rpc<{ runId?: string }>(
          'chat.send',
          chatSendParams,
          CHAT_SEND_TIMEOUT_MS,
        );
        result = { success: true, result: rpcResult };
      }

      console.log(`[sendMessage] RPC result: success=${result.success}, runId=${result.result?.runId || 'none'}`);
      if (needsPatch) {
        deferSessionThinkingLevelPatch(currentSessionKey, reasoningMode);
      }
      if (_pendingSessionModelPatches.has(currentSessionKey)) {
        void flushPendingSessionModelPatches(currentSessionKey);
      }

      if (!result.success) {
        const errorMsg = result.error || 'Failed to send message';
        if (isUserSecurityDenialMessage(errorMsg)) {
          clearHistoryPoll();
          _pendingComplexTaskPlans.delete(currentSessionKey);
          set(buildSecurityDenialState(errorMsg));
        } else if (isRecoverableChatSendTimeout(errorMsg)) {
          console.warn(`[sendMessage] Recoverable chat.send timeout, keeping poll alive: ${errorMsg}`);
        } else {
          clearHistoryPoll();
          const normalizedError = normalizeAppError(new Error(errorMsg));
          set({ error: toUserMessage(normalizedError), sending: false });
        }
      } else if (result.result?.runId && get().sending) {
        const runId = result.result.runId;
        if (_deIsDigital && _resolvedTargetAgentId) {
          _digitalEmployeeRuns.set(runId, {
            agentId: _resolvedTargetAgentId,
            name: _deDisplayName || _resolvedTargetAgentId,
          });
        }
        const pendingPlan = _pendingComplexTaskPlans.get(currentSessionKey);
        if (pendingPlan) {
          _pendingComplexTaskPlans.set(currentSessionKey, {
            ...pendingPlan,
            planningRunId: runId,
          });
        }
        const boundObservation = bindRunIdToObservation(
          get().sessionRunawayToolObservations[currentSessionKey] ?? get().runawayToolObservation,
          runId,
        );
        set((s) => ({
          activeRunId: runId,
          runawayToolObservation: boundObservation,
          sessionRunawayToolObservations: {
            ...s.sessionRunawayToolObservations,
            [currentSessionKey]: boundObservation,
          },
          sessionStreamingStates: {
            ...s.sessionStreamingStates,
            [currentSessionKey]: {
              ...(s.sessionStreamingStates[currentSessionKey] ?? createEmptySessionStreamingState()),
              activeRunId: runId,
              sending: true,
              runAborted: false,
              messagesSnapshot: s.messages.length > 0
                ? [...s.messages]
                : (s.sessionStreamingStates[currentSessionKey]?.messagesSnapshot ?? []),
            },
          },
        }));
      }
    } catch (err) {
      const errStr = String(err);
      if (isUserSecurityDenialMessage(errStr)) {
        clearHistoryPoll();
        _pendingComplexTaskPlans.delete(currentSessionKey);
        set(buildSecurityDenialState(errStr));
      } else if (isRecoverableChatSendTimeout(errStr)) {
        console.warn(`[sendMessage] Recoverable chat.send timeout, keeping poll alive: ${errStr}`);
      } else {
        clearHistoryPoll();
        const normalizedError = normalizeAppError(err);
        set({ error: toUserMessage(normalizedError), sending: false });
      }
    }
  },

  // ���� Abort active run ����

  abortRun: async () => {
    clearHistoryPoll();
    clearSessionActivityPoll();
    clearErrorRecoveryTimer();
    clearPendingSilentRetry();
    markAbortHistoryQuietPeriod();
    const { currentSessionKey, messages, activeRunId, gatewayBackgroundActivity } = get();
    markUserAbort();
    if (activeRunId) {
      markAbortedChatRun(activeRunId);
    }
    persistUserAbortedSession(currentSessionKey, activeRunId);
    if (_interruptedSendSession?.sessionKey === currentSessionKey) {
      _interruptedSendSession = null;
    }
    const lastUser = getLastRealUserSnapshot(messages);
    const dedupedMessages = dedupeEquivalentAttachmentUserMessages(messages);
    const workspaceId = useWorkspacesStore.getState().currentWorkspaceId;
    set((s) => ({
      ...buildSessionRegistrationPatch(s, currentSessionKey, lastUser, workspaceId),
      messages: dedupedMessages,
      sending: false,
      activeRunId: null,
      streamingText: '',
      streamingMessage: null,
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      runAborted: true,
      streamingTools: [],
      sessionStreamingStates: {
        ...s.sessionStreamingStates,
        [currentSessionKey]: {
          ...(s.sessionStreamingStates[currentSessionKey] ?? createEmptySessionStreamingState()),
          messagesSnapshot: dedupedMessages.length > 0 ? [...dedupedMessages] : (s.sessionStreamingStates[currentSessionKey]?.messagesSnapshot ?? []),
          sending: false,
          runAborted: true,
          activeRunId: null,
        },
      },
    }));

    try {
      const rpc = useGatewayStore.getState().rpc.bind(useGatewayStore.getState());
      await Promise.all([
        rpc(
          'sessions.abort',
          {
            key: currentSessionKey,
            ...(activeRunId ? { runId: activeRunId } : {}),
          },
          10_000,
        ),
        abortPendingChildDelegations(
          messages,
          rpc,
          gatewayBackgroundActivity?.processingSessionKeys ?? [],
        ),
      ]);
    } catch (err) {
      // ���� abort ������Ϊ�û�������ֹ�Ựʱ RPC ���ܱ���??
      const errStr = String(err);
      if (!errStr.includes('aborted') && !errStr.includes('abort')) {
        set({ error: errStr });
      }
    }

    // Sync transcript after stop so any reply that landed on disk while the UI
    // was desynced becomes visible without requiring another interaction.
    void get().loadHistory(true, { force: true });
  },

  // ���� Handle incoming chat events from Gateway ����

  handleChatEvent: (event: Record<string, unknown>) => {
    const runId = String(event.runId || '');
    const eventState = String(event.state || '');
    const eventSessionKey = event.sessionKey != null ? String(event.sessionKey) : null;
    const { activeRunId, currentSessionKey } = get();
    const isCurrentSessionEvent = eventSessionKey == null || eventSessionKey === currentSessionKey;

    // The child that triggers a parent's auto-announce wrap-up never gets an
    // `[Internal task completion event]` written to the parent transcript — its
    // completion is encoded only in this run id. Record it so its execution-graph
    // branch settles instead of being stranded "running".
    if (runId && isSubagentDelegationAnnounceRun(runId)) {
      const announcedChildKey = parseChildSessionKeyFromAnnounceRun(runId);
      if (announcedChildKey && !get().announcedChildSessionKeys.includes(announcedChildKey)) {
        set((s) => (
          s.announcedChildSessionKeys.includes(announcedChildKey)
            ? {}
            : { announcedChildSessionKeys: [...s.announcedChildSessionKeys, announcedChildKey] }
        ));
      }
    }

    if (!isCurrentSessionEvent) {
      if (isDuplicateChatEvent(eventState, event)) return;
      _lastChatEventAt = Date.now();

      let backgroundState = eventState;
      if (!backgroundState && event.message && typeof event.message === 'object') {
        const msg = event.message as Record<string, unknown>;
        const stopReason = msg.stopReason ?? msg.stop_reason;
        if (stopReason) {
          backgroundState = 'final';
        } else if (msg.role || msg.content) {
          backgroundState = 'delta';
        }
      }

      if (eventSessionKey && isUserAbortedSession(eventSessionKey)) {
        if (backgroundState === 'aborted' || backgroundState === 'final' || backgroundState === 'error') {
          clearUserAbortedSession(eventSessionKey);
        } else {
          return;
        }
      }

      if (runId && isAbortedChatRun(runId)) {
        if (backgroundState === 'aborted' || backgroundState === 'final' || backgroundState === 'error') {
          forgetAbortedChatRun(runId);
        } else {
          return;
        }
      }

      const backgroundObservationPatch = recordRunawayToolObservationForStore(
        get(),
        event,
        backgroundState,
        runId,
        eventSessionKey,
      );
      if (backgroundObservationPatch) {
        set(backgroundObservationPatch);
      }

      const nextSessionStreamingStates = applyBackgroundChatEvent(get(), eventSessionKey, event, backgroundState, runId);
      if (nextSessionStreamingStates) {
        set({ sessionStreamingStates: nextSessionStreamingStates });
      }
      return;
    }

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

    const isTerminalEvent = resolvedState === 'final' || resolvedState === 'error' || resolvedState === 'aborted';
    // Approval followups resume the same user-visible run with a synthetic
    // runId. Let terminal events reconcile even if the active run snapshot is
    // stale, but keep non-terminal deltas isolated to the current run.
    const matchesCurrentRun = shouldProcessCurrentSessionRunEvent(activeRunId, runId);
    if (!isTerminalEvent && !matchesCurrentRun) return;

    // Events for a session the user isn't currently viewing must not mutate the
    // visible streaming fields. We still finalize that background session's
    // saved streaming state when its run completes, otherwise switching back
    // strands it on a frozen "thinking?? indicator and blocks the loadHistory
    // that would surface the finished answer.
    if (eventSessionKey != null && eventSessionKey !== currentSessionKey) {
      finalizeBackgroundSessionRunIfCompleted(set, get, eventSessionKey, event, resolvedState, runId);
      return;
    }

    if (isDuplicateChatEvent(eventState, event)) return;

    _lastChatEventAt = Date.now();

    const wasUserAbortedRun = Boolean(runId && isAbortedChatRun(runId));
    if (wasUserAbortedRun) {
      if (resolvedState === 'aborted' || resolvedState === 'final' || resolvedState === 'error') {
        forgetAbortedChatRun(runId);
      } else {
        return;
      }
    }

    const foregroundSessionKey = eventSessionKey ?? currentSessionKey;
    if (isUserAbortedSession(foregroundSessionKey)) {
      if (resolvedState === 'aborted' || resolvedState === 'final' || resolvedState === 'error') {
        clearUserAbortedSession(foregroundSessionKey);
      } else if (resolvedState === 'started' || resolvedState === 'delta') {
        return;
      }
    }

    const { runAborted, sending: isSending } = get();
    if (runAborted && !isSending && (resolvedState === 'delta' || resolvedState === 'started')) {
      return;
    }

    const observationPatch = recordRunawayToolObservationForStore(
      get(),
      event,
      resolvedState,
      runId,
      currentSessionKey,
    );
    if (observationPatch) {
      set(observationPatch);
    }

    // Only pause the history poll when we receive user-visible streaming data
    // or a terminal event. Placeholder deltas must not kill the fallback poll.
    const hasTerminalData = resolvedState === 'final' || resolvedState === 'error' || resolvedState === 'aborted';
    const visibleProgress = classifyVisibleProgress(event.message);
    const hasUsefulData = hasTerminalData || visibleProgress.visible;
    if (hasUsefulData) {
      clearHistoryPoll();
      // Adopt run started from another client (e.g. console at 127.0.0.1:18789):
      // show loading/streaming in the app when this session has an active run.
      const { sending, activeRunId: storedRunId, runAborted } = get();
      if (
        !sending
        && !runAborted
        && runId
        && !isAbortedChatRun(runId)
        && !isUserAbortedSession(foregroundSessionKey)
        && shouldAdoptStreamingRun(eventSessionKey, runId, storedRunId)
      ) {
        set({ sending: true, activeRunId: runId, error: null, runAborted: false });
      }
    }

    switch (resolvedState) {
      case 'started': {
        // Run just started (e.g. from console); show loading immediately.
        const { sending: currentSending, activeRunId: storedRunId, runAborted } = get();
        if (
          !currentSending
          && !runAborted
          && runId
          && !isAbortedChatRun(runId)
          && !isUserAbortedSession(foregroundSessionKey)
          && shouldAdoptStreamingRun(eventSessionKey, runId, storedRunId)
        ) {
          set({ sending: true, activeRunId: runId, error: null, runAborted: false });
        }
        break;
      }
      case 'delta': {
        if (get().runAborted || (runId && isAbortedChatRun(runId))) break;
        // Clear any stale error (including RPC timeout) when new data arrives.
        if (_errorRecoveryTimer) {
          clearErrorRecoveryTimer();
        }
        if (get().error) {
          set({ error: null });
        }
        const updates = collectToolUpdates(event.message, resolvedState);
        set((s) => ({
          streamingMessage: (() => {
            if (event.message && typeof event.message === 'object') {
              const msgObj = event.message as RawMessage;
              const msgRole = msgObj.role;
              if (isToolResultRole(msgRole)) return s.streamingMessage;
              // During multi-model fallback, guard against empty/role-only deltas
              if (s.streamingMessage && msgObj.content === undefined) {
                return s.streamingMessage;
              }
              const msgContent = getMessageText(msgObj.content);
              if (msgContent.trim() && shouldSuppressAssistantStreamingText(msgContent)) {
                return null;
              }
            }
            return annotateDigitalEmployeeMessage(
              normalizeStreamingMessage(event.message ?? s.streamingMessage) as RawMessage,
              runId,
            );
          })(),
          streamingTools: updates.length > 0 ? upsertToolStatuses(s.streamingTools, updates) : s.streamingTools,
        }));
        break;
      }
      case 'final': {
        if (!matchesCurrentRun) {
          clearHistoryPoll();
          void get().loadHistory(true, { force: true }).finally(() => {
            ensureSessionBackendPolling(currentSessionKey, set, get);
          });
          break;
        }

        const finalBeforeState = get();
        console.info('[chat.final.before]', {
          runId,
          eventSessionKey,
          currentSessionKey: finalBeforeState.currentSessionKey,
          activeRunId: finalBeforeState.activeRunId,
          sending: finalBeforeState.sending,
          pendingFinal: finalBeforeState.pendingFinal,
          hasStreamingMessage: Boolean(finalBeforeState.streamingMessage),
          streamingTextLength: finalBeforeState.streamingText.length,
          streamingTools: finalBeforeState.streamingTools.map((tool) => ({
            id: tool.id,
            name: tool.name,
            status: tool.status,
          })),
          sessionStreamingState: (() => {
            const state = finalBeforeState.sessionStreamingStates[eventSessionKey ?? finalBeforeState.currentSessionKey];
            return state ? {
              activeRunId: state.activeRunId,
              sending: state.sending,
              pendingFinal: state.pendingFinal,
              hasStreamingMessage: Boolean(state.streamingMessage),
              streamingTools: state.streamingTools.length,
            } : null;
          })(),
        });
        clearErrorRecoveryTimer();
        if (get().error) set({ error: null });
        if (get().runError) set({ runError: null });
        // Message complete - add to history and clear streaming
        const finalMsg = event.message as RawMessage | undefined;
        if (finalMsg) {
          const normalizedFinalMessage = annotateDigitalEmployeeMessage(
            normalizeStreamingMessage(finalMsg) as RawMessage,
            runId,
          ) as RawMessage;

          console.log('[DEBUG] [context-compress] handleChatEvent final', {
            role: normalizedFinalMessage.role,
            toolCallId: (normalizedFinalMessage as unknown as Record<string, unknown>).toolCallId,
            isToolResult: isToolResultRole(normalizedFinalMessage.role),
            contentSize: JSON.stringify(normalizedFinalMessage.content).length,
          });

          // ���� Silent retry for tool stream errors ����
          if (
            normalizedFinalMessage.role === 'assistant'
            && runId
            && !_retriedRunIds.has(runId)
          ) {
            const stopReason = (normalizedFinalMessage as unknown as Record<string, unknown>).stopReason
              ?? (normalizedFinalMessage as unknown as Record<string, unknown>).stop_reason;
            if (stopReason === 'error') {
              const errorMessage = (normalizedFinalMessage as unknown as Record<string, unknown>).errorMessage
                ?? (normalizedFinalMessage as unknown as Record<string, unknown>).error_message;
              const errorText = typeof errorMessage === 'string' ? errorMessage : '';
              if (isToolStreamError(errorText) && _lastSendParams) {
                console.warn('[chat.runtime] tool stream error, attempting silent retry once', {
                  runId,
                  error: errorText,
                });
                _retriedRunIds.add(runId);

                // Clear streaming state silently, keep sending=true
                set({
                  streamingText: '',
                  streamingMessage: null,
                  streamingTools: [],
                  pendingFinal: false,
                  pendingToolImages: [],
                  error: null,
                });

                // Abort the failed run on gateway and wait before retrying once.
                void (async () => {
                  abortGatewayRun(currentSessionKey);
                  await sleep(300);
                  const activity = await refreshSessionBackendActivity(currentSessionKey);
                  if (activity?.session.hasTrackedUserRun) {
                    await sleep(500);
                  }
                  const state = get();
                  if (!state.sending || state.currentSessionKey !== currentSessionKey) return;
                  const params = _lastSendParams!;
                  _suppressNextOptimisticUserMessage = true;
                  void state.sendMessage(params.text, params.attachments, params._resolvedTargetAgentId);
                })();

                // Don't snapshot the failed message, don't set error, don't loadHistory
                break;
              }
            }
          }

          if (isTerminalAssistantErrorMessage(normalizedFinalMessage)) {
            const messageError = getMessageErrorMessage(normalizedFinalMessage);
            clearHistoryPoll();
            if (isUserSecurityDenialMessage(messageError)) {
              set(buildSecurityDenialState(messageError));
              break;
            }
            if (isSuppressedRunError(messageError)
              || shouldSuppressPartialSuccessRunError(messageError, normalizedFinalMessage)) {
              set({
                streamingText: '',
                streamingMessage: null,
                sending: false,
                activeRunId: null,
                pendingFinal: false,
                error: null,
                runError: null,
              });
              void get().loadHistory(true);
              break;
            }
            if (shouldTreatAbortAsUserStop(messageError, {
              runId,
              runAborted: get().runAborted || wasUserAbortedRun,
            })) {
              set({
                streamingText: '',
                streamingMessage: null,
                sending: false,
                activeRunId: null,
                pendingFinal: false,
                error: null,
                runError: null,
              });
              void get().loadHistory(true);
              break;
            }
            const resolvedMessageError = resolveRunFailureErrorMessage(messageError);
            set({
              streamingText: '',
              streamingMessage: null,
              sending: false,
              activeRunId: null,
              pendingFinal: false,
              error: resolvedMessageError,
              runError: resolvedMessageError,
              runAborted: isAbortErrorMessage(messageError),
            });
            break;
          }

          if (shouldSilentlyFinalizeRunOnAssistantFinal(normalizedFinalMessage)) {
            if (deferClearUserTurnForOpenDelegation(get, set, {
              sessionKey: get().currentSessionKey,
              runId,
            })) {
              clearHistoryPoll();
              void get().loadHistory(true, { force: true });
              break;
            }
            void tryFinalizeUserTurnAfterAssistantFinal(get, set, {
              sessionKey: get().currentSessionKey,
              runId,
              terminalMessage: normalizedFinalMessage,
            });
            clearHistoryPoll();
            void get().loadHistory(true, { force: true });
            break;
          }
          const updates = collectToolUpdates(normalizedFinalMessage, resolvedState);
          if (isToolResultRole(normalizedFinalMessage.role)) {
            // Resolve file path from the streaming assistant message's matching tool call
            const currentStreamForPath = get().streamingMessage as RawMessage | null;
            const matchedPath = (currentStreamForPath && normalizedFinalMessage.toolCallId)
              ? getToolCallFilePath(currentStreamForPath, normalizedFinalMessage.toolCallId)
              : undefined;

            // Mirror enrichWithToolResultFiles: collect images + file refs for next assistant msg
            const toolFiles: AttachedFileMeta[] = extractImagesAsAttachedFiles(normalizedFinalMessage.content).map(
              (file) => (file.source ? file : { ...file, source: 'tool-result' as const }),
            );
            if (matchedPath) {
              for (const f of toolFiles) {
                if (!f.filePath) {
                  f.filePath = matchedPath;
                  f.fileName = attachmentFileNameFromPath(matchedPath);
                }
              }
            }
            const text = getMessageText(normalizedFinalMessage.content);
            if (text) {
              const mediaRefs = extractMediaRefs(text);
              const mediaRefPaths = new Set(mediaRefs.map(r => r.filePath));
              for (const ref of mediaRefs) toolFiles.push(makeAttachedFile(ref, 'tool-result'));
              for (const ref of extractRawFilePaths(text)) {
                if (!mediaRefPaths.has(ref.filePath)) toolFiles.push(makeAttachedFile(ref, 'tool-result'));
              }
            }
            set((s) => {
              // Snapshot the current streaming assistant message (thinking + tool_use) into
              // messages[] before clearing it. The Gateway does NOT send separate 'final'
              // events for intermediate tool-use turns ??it only sends deltas and then the
              // tool result. Without snapshotting here, the intermediate thinking+tool steps
              // would be overwritten by the next turn's deltas and never appear in the UI.
              const currentStream = s.streamingMessage as RawMessage | null;
              const snapshotMsgs = snapshotStreamingAssistantMessage(currentStream, s.messages, runId);
              return {
                messages: snapshotMsgs.length > 0 ? [...s.messages, ...snapshotMsgs] : s.messages,
                streamingText: '',
                streamingMessage: null,
                pendingFinal: true,
                pendingToolImages: toolFiles.length > 0
                  ? [...s.pendingToolImages, ...toolFiles]
                  : s.pendingToolImages,
                streamingTools: updates.length > 0 ? upsertToolStatuses(s.streamingTools, updates) : s.streamingTools,
              };
            });
            break;
          }
          const toolOnly = isToolOnlyMessage(normalizedFinalMessage);
          const hasOutput = hasNonToolAssistantContent(normalizedFinalMessage);
          const userIdx = findLatestVisibleUserIndex(get().messages);
          const turnMessages = userIdx >= 0 ? get().messages.slice(userIdx + 1) : get().messages;
          const isConcluding = isConcludingAssistantReply(
            normalizedFinalMessage,
            [...turnMessages, normalizedFinalMessage],
          );
          // Pure text Q&A without tool activity: the assistant's visible reply
          // is the final answer. Treat it as terminal so the run can finalize
          // even when the provider omits stopReason on the message.
          const hasToolActivityInTurn = turnMessages.some((m) => {
            if (isToolResultRole(m.role)) return true;
            if (m.role !== 'assistant') return false;
            return isToolOnlyMessage(m);
          });
          const currentHasToolActivity = toolOnly || updates.length > 0;
          const isSimpleTextResponse = !hasToolActivityInTurn && !currentHasToolActivity && hasOutput;
          const keepRunActiveAfterFinal = !isExecApprovalFollowupRun(runId)
            && !isRunTerminalAssistantMessage(normalizedFinalMessage)
            && !isConcluding
            && (
              currentHasToolActivity
              || isSimpleTextResponse
              || shouldKeepRunActiveAfterAssistantFinal(normalizedFinalMessage)
            );
          const msgId = normalizedFinalMessage.id || (keepRunActiveAfterFinal ? `run-${runId}-tool-${Date.now()}` : `run-${runId}`);
          let skippedDuplicateFinal = false;
          set((s) => {
            const nextTools = updates.length > 0 ? upsertToolStatuses(s.streamingTools, updates) : s.streamingTools;
            const streamingTools = hasOutput && !keepRunActiveAfterFinal ? [] : nextTools;

            // Attach any images collected from preceding tool results
            const pendingImgs = s.pendingToolImages;
            const msgWithImages: RawMessage = pendingImgs.length > 0
              ? {
                ...normalizedFinalMessage,
                role: (normalizedFinalMessage.role || 'assistant') as RawMessage['role'],
                id: msgId,
                _attachedFiles: [...(normalizedFinalMessage._attachedFiles || []), ...pendingImgs],
              }
              : { ...normalizedFinalMessage, role: (normalizedFinalMessage.role || 'assistant') as RawMessage['role'], id: msgId };
            const clearPendingImages = { pendingToolImages: [] as AttachedFileMeta[] };

            // Check if message already exists (prevent duplicates)
            const alreadyExists = isDuplicateAssistantFinal(s.messages, msgId, msgWithImages);
            if (alreadyExists) {
              skippedDuplicateFinal = true;
              return keepRunActiveAfterFinal ? {
                streamingText: '',
                streamingMessage: null,
                pendingFinal: true,
                streamingTools,
                ...clearPendingImages,
              } : {
                streamingText: '',
                streamingMessage: null,
                sending: keepRunActiveAfterFinal ? s.sending : false,
                activeRunId: keepRunActiveAfterFinal ? s.activeRunId : null,
                pendingFinal: keepRunActiveAfterFinal ? true : false,
                streamingTools,
                ...clearPendingImages,
              };
            }
            return keepRunActiveAfterFinal ? {
              messages: [...s.messages, msgWithImages],
              streamingText: '',
              streamingMessage: null,
              pendingFinal: true,
              streamingTools,
              runError: null,
              ...clearPendingImages,
            } : {
              messages: [...s.messages, msgWithImages],
              streamingText: '',
              streamingMessage: null,
              sending: keepRunActiveAfterFinal ? s.sending : false,
              activeRunId: keepRunActiveAfterFinal ? s.activeRunId : null,
              pendingFinal: keepRunActiveAfterFinal ? true : false,
              streamingTools,
              runError: null,
              ...clearPendingImages,
            };
          });
          if (!skippedDuplicateFinal) {
            // After the final response, always reload history to surface all intermediate
            // tool-use turns (thinking + tool blocks) from the Gateway's authoritative
            // record and to let applyLoadedMessages detect terminal/concluding replies.
            clearHistoryPoll();
            void get().loadHistory(true, { force: true });
          }

          if (!keepRunActiveAfterFinal || isSimpleTextResponse) {
            void tryFinalizeUserTurnAfterAssistantFinal(get, set, {
              sessionKey: get().currentSessionKey,
              runId,
              terminalMessage: normalizedFinalMessage,
            });
            const pendingPlan = _pendingComplexTaskPlans.get(currentSessionKey);
            const finalText = getMessageText(normalizedFinalMessage.content);
            const isPlanningRun = pendingPlan
              && (!pendingPlan.planningRunId || pendingPlan.planningRunId === runId);
            if (isPlanningRun && finalText.trim()) {
              _pendingComplexTaskPlans.delete(currentSessionKey);
              const executionRequest = buildComplexTaskExecutionRequest(
                pendingPlan.originalMessage,
                finalText,
              );
              window.setTimeout(() => {
                const state = get();
                if (state.currentSessionKey !== currentSessionKey || state.sending) return;
                void state.sendMessage(executionRequest);
              }, 250);
            }
          } else {
            // Even when the final message lacks a terminal stopReason and the
            // turn had no tool activity (simple text Q&A), still attempt to
            // finalize so the run doesn't stay stuck in pendingFinal indefinitely.
            void tryFinalizeUserTurnAfterAssistantFinal(get, set, {
              sessionKey: get().currentSessionKey,
              runId,
              terminalMessage: normalizedFinalMessage,
            });
          }
        } else {
          const { activeRunId: currentActiveRunId } = get();
          if (isExecApprovalFollowupRun(runId)) {
            clearHistoryPoll();
            set(buildClearedActiveRunPatch());
            break;
          }
          if (runId && currentActiveRunId && runId !== currentActiveRunId && !isExecApprovalFollowupRun(runId)) {
            const skippedState = get();
            console.info('[chat.final.after]', {
              runId,
              skipped: true,
              reason: 'active-run-mismatch',
              currentSessionKey: skippedState.currentSessionKey,
              activeRunId: skippedState.activeRunId,
              sending: skippedState.sending,
              pendingFinal: skippedState.pendingFinal,
              hasStreamingMessage: Boolean(skippedState.streamingMessage),
              streamingTextLength: skippedState.streamingText.length,
              streamingTools: skippedState.streamingTools.length,
            });
            break;
          }
          void confirmEmptyFinalWithHistory(set, get, runId);
        }
        const finalAfterState = get();
        console.info('[chat.final.after]', {
          runId,
          currentSessionKey: finalAfterState.currentSessionKey,
          activeRunId: finalAfterState.activeRunId,
          sending: finalAfterState.sending,
          pendingFinal: finalAfterState.pendingFinal,
          hasStreamingMessage: Boolean(finalAfterState.streamingMessage),
          streamingTextLength: finalAfterState.streamingText.length,
          streamingTools: finalAfterState.streamingTools.map((tool) => ({
            id: tool.id,
            name: tool.name,
            status: tool.status,
          })),
          sessionStreamingState: (() => {
            const state = finalAfterState.sessionStreamingStates[eventSessionKey ?? finalAfterState.currentSessionKey];
            return state ? {
              activeRunId: state.activeRunId,
              sending: state.sending,
              pendingFinal: state.pendingFinal,
              hasStreamingMessage: Boolean(state.streamingMessage),
              streamingTools: state.streamingTools.length,
            } : null;
          })(),
        });
        break;
      }
      case 'error': {
        const eventRecord = event as Record<string, unknown>;
        const rawErrorMsg = String(
          event.errorMessage
          ?? eventRecord.error
          ?? 'An error occurred',
        );

        // ���� User-initiated stop ����
        // When the user clicks the stop button, the runtime may still emit an
        // `error` event carrying an "abort" message. Treat that as a clean stop
        // and suppress the error bar instead of surfacing it to the user.
        // The terminal `aborted` event can arrive first (clearing runAborted and
        // forgetting the run id), so we also honor a short post-stop time window.
        if (shouldTreatAbortAsUserStop(rawErrorMsg, {
          runId,
          runAborted: wasUserAbortedRun || get().runAborted,
        })) {
          clearErrorRecoveryTimer();
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
            error: null,
          });
          break;
        }

        // ���� Silent retry for tool stream errors ����
        if (runId && !_retriedRunIds.has(runId) && isToolStreamError(rawErrorMsg) && _lastSendParams) {
          console.warn('[chat.runtime] tool stream error event, attempting silent retry once', {
            runId,
            error: rawErrorMsg,
          });
          _retriedRunIds.add(runId);

          // Clear failed state silently, keep sending=true
          set({
            streamingText: '',
            streamingMessage: null,
            streamingTools: [],
            pendingFinal: false,
            pendingToolImages: [],
            error: null,
          });

          // Abort failed run and wait before retrying once.
          void (async () => {
            abortGatewayRun(currentSessionKey);
            await sleep(300);
            const activity = await refreshSessionBackendActivity(currentSessionKey);
            if (activity?.session.hasTrackedUserRun) {
              await sleep(500);
            }
            const state = get();
            if (!state.sending || state.currentSessionKey !== currentSessionKey) return;
            const params = _lastSendParams!;
            _suppressNextOptimisticUserMessage = true;
            void state.sendMessage(params.text, params.attachments, params._resolvedTargetAgentId);
          })();
          break;
        }
        const errorMsg = getRuntimeEventErrorMessage(event);
        const wasSending = get().sending;
        const isGenericError = !rawErrorMsg.trim()
          || rawErrorMsg === 'An error occurred'
          || errorMsg === 'An error occurred';

        if (isUserSecurityDenialMessage(errorMsg)) {
          clearErrorRecoveryTimer();
          clearHistoryPoll();
          _pendingComplexTaskPlans.delete(currentSessionKey);
          set(buildSecurityDenialState(errorMsg));
          break;
        }

        if (isSuppressedRunError(errorMsg)) {
          clearErrorRecoveryTimer();
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
            error: null,
            runError: null,
          });
          void get().loadHistory(true);
          break;
        }

        if (wasSending && isGenericError) {
          // 空泛错误（"An error occurred"）通常是 Gateway 内部瞬时抖动。
          // 但 Gateway 已明确放弃本次 run，不应继续等待；终止 sending 状态。
          clearErrorRecoveryTimer();
          clearHistoryPoll();
          set({
            streamingText: '',
            streamingMessage: null,
            streamingTools: [],
            pendingFinal: false,
            pendingToolImages: [],
            sending: false,
            activeRunId: null,
            lastUserMessageAt: null,
          });
          void get().loadHistory(true, { force: true });
          break;
        }

        // Snapshot the current streaming message into messages[] so partial
        // content ("Let me get that written down...") is preserved in the UI
        // rather than being silently discarded.
        const currentStream = get().streamingMessage as RawMessage | null;
        const errorSnapshot = snapshotStreamingAssistantMessage(
          currentStream,
          get().messages,
          `error-${runId || Date.now()}`,
        );
        if (errorSnapshot.length > 0) {
          set((s) => ({
            messages: [...s.messages, ...errorSnapshot],
          }));
        }

        const recoverableError = isRecoverableRuntimeError(errorMsg);

        // Gateway 发出 error 事件意味着其内部重试（指数退避 + 模型回退）已全部
        // 耗尽，不会再自动恢复。此时应终止 thinking 状态，避免 UI 卡在"思考中"。
        // loadHistory 会从后端拉取最新消息（如果 Gateway 在最后时刻 commit 了部分
        // 回复），用户至少能看到已完成的内容。
        if (recoverableError) {
          clearErrorRecoveryTimer();
          clearHistoryPoll();
          set({
            streamingText: '',
            streamingMessage: null,
            streamingTools: [],
            pendingFinal: false,
            pendingToolImages: [],
            sending: false,
            activeRunId: null,
            lastUserMessageAt: null,
          });
          if (wasSending) {
            void get().loadHistory(true, { force: true });
          }
          break;
        }

        // 只有真正阻塞任务继续的致命错误才展示给用户，
        // 其他一切运行时错误只记日志，避免干扰用户体验。
        if (isFatalRuntimeError(rawErrorMsg)) {
          const userIdx2 = findLatestVisibleUserIndex(get().messages);
          const hasReply = userIdx2 >= 0
            && get().messages.slice(userIdx2 + 1).some(
              (m) => m.role === 'assistant' && hasVisibleAssistantContent(m),
            );
          if (hasReply) {
            // 致命错误（API key / 认证等）即使已有部分回复也应告知用户。
            // 任务可能在中间状态中断，静默吞掉会让用户误以为一切正常。
            const displayError = resolveRunFailureErrorMessage(rawErrorMsg);
            console.warn('[chat.error-fatal] 致命错误（已有回复），仍展示提示', {
              error: rawErrorMsg,
              runId,
            });
            set({
              error: displayError,
              runError: displayError,
              streamingText: '',
              streamingMessage: null,
              streamingTools: [],
              pendingFinal: false,
              pendingToolImages: [],
              sending: false,
              activeRunId: null,
              lastUserMessageAt: null,
              runAborted: isAbortErrorMessage(rawErrorMsg),
            });
            break;
          }
          const displayError = resolveRunFailureErrorMessage(rawErrorMsg);
          set({
            error: displayError,
            runError: displayError,
            streamingText: '',
            streamingMessage: null,
            streamingTools: [],
            pendingFinal: false,
            pendingToolImages: [],
            sending: false,
            activeRunId: null,
            lastUserMessageAt: null,
            runAborted: isAbortErrorMessage(rawErrorMsg),
          });
        } else {
          // 非致命但不在已知可恢复/致命模式内的错误。Gateway 已放弃本次 run，
          // 不应静默吞掉。展示简短的终止提示让用户知道任务未正常完成。
          const displayError = resolveRunFailureErrorMessage(rawErrorMsg);
          console.warn('[chat.error-fallback] 未识别错误类型，终止本次运行', {
            error: rawErrorMsg,
            displayError,
            runId,
          });
          set({
            error: displayError,
            runError: displayError,
            streamingText: '',
            streamingMessage: null,
            streamingTools: [],
            pendingFinal: false,
            pendingToolImages: [],
            sending: false,
            activeRunId: null,
            lastUserMessageAt: null,
            runAborted: isAbortErrorMessage(rawErrorMsg),
          });
        }

        if (wasSending) {
          clearHistoryPoll();
          void get().loadHistory(true, { force: true });
        }
        break;
      }
      case 'aborted': {
        clearHistoryPoll();
        clearErrorRecoveryTimer();
        // Recognize a user-initiated stop broadly. The run id is already
        // forgotten above (line ~5199) for terminal states, so re-checking
        // `isAbortedChatRun(runId)` alone misses the user's own stop and shows
        // the "运行被意外中断" banner. Mirror the `error` path: honor the run id
        // captured before the forget, the runAborted flag, the post-stop time
        // window, and the user-aborted-session marker. A genuine system abort
        // (no user-stop signal) still surfaces the banner.
        const isUserAbort = wasUserAbortedRun
          || Boolean(runId && isAbortedChatRun(runId))
          || get().runAborted
          || isWithinUserAbortWindow()
          || isUserAbortedSession(foregroundSessionKey);
        if (isUserAbort) {
          if (runId) forgetAbortedChatRun(runId);
          const lastUser = getLastRealUserSnapshot(get().messages);
          const workspaceId = useWorkspacesStore.getState().currentWorkspaceId;
          set((s) => ({
            ...buildSessionRegistrationPatch(s, currentSessionKey, lastUser, workspaceId),
            sending: false,
            activeRunId: null,
            runAborted: false,
            streamingText: '',
            streamingMessage: null,
            streamingTools: [],
            pendingFinal: false,
            lastUserMessageAt: null,
            pendingToolImages: [],
            error: null,
            runError: null,
          }));
          break;
        }

        const displayError = i18n.t('chat:errors.runAbortedBySystem');
        const lastUser = getLastRealUserSnapshot(get().messages);
        const workspaceId = useWorkspacesStore.getState().currentWorkspaceId;
        set((s) => ({
          ...buildSessionRegistrationPatch(s, currentSessionKey, lastUser, workspaceId),
          sending: false,
          activeRunId: null,
          runAborted: true,
          streamingText: '',
          streamingMessage: null,
          streamingTools: [],
          pendingFinal: false,
          lastUserMessageAt: null,
          pendingToolImages: [],
          error: displayError,
          runError: displayError,
        }));
        void get().loadHistory(true, { force: true });
        break;
      }
      default: {
        // Unknown or empty state ??if we're currently sending and receive an event
        // with a message, attempt to process it as streaming data. This handles
        // edge cases where the Gateway sends events without a state field.
        const { sending, runAborted } = get();
        if (runAborted || (runId && isAbortedChatRun(runId))) break;
        if (sending && event.message && typeof event.message === 'object') {
          console.warn(`[handleChatEvent] Unknown event state "${resolvedState}", treating message as streaming delta. Event keys:`, Object.keys(event));
          const updates = collectToolUpdates(event.message, 'delta');
          set((s) => ({
            streamingMessage: event.message ?? s.streamingMessage,
            streamingTools: updates.length > 0 ? upsertToolStatuses(s.streamingTools, updates) : s.streamingTools,
          }));
        }
        break;
      }
    }

    set((s) => ({
      sessionStreamingStates: {
        ...s.sessionStreamingStates,
        [s.currentSessionKey]: snapshotCurrentStreamingState(s),
      },
    }));
  },
  handleGatewayRunCompleted: (runId?: string | null, sessionKey?: string | null) => {
    const state = get();
    const resolvedSessionKey = sessionKey != null ? String(sessionKey) : state.currentSessionKey;
    const resolvedRunId = runId != null ? String(runId) : null;
    const matchesSession = resolvedSessionKey === state.currentSessionKey;
    const matchesRun = !resolvedRunId || !state.activeRunId || state.activeRunId === resolvedRunId;

    const background = state.sessionStreamingStates[resolvedSessionKey];
    if (
      background
      && (background.sending || background.activeRunId)
      && (!resolvedRunId || !background.activeRunId || background.activeRunId === resolvedRunId)
    ) {
      set((s) => ({
        sessionStreamingStates: {
          ...s.sessionStreamingStates,
          [resolvedSessionKey]: {
            ...background,
            ...buildClearedActiveRunPatch(),
            messagesSnapshot: [],
          },
        },
      }));
    }

    if (!matchesSession || (!state.sending && !state.pendingFinal && !state.activeRunId)) {
      return;
    }
    if (!matchesRun) return;

    const finalizeAfterHistory = (attempt: number) => {
      void get().loadHistory(true, { force: true }).finally(async () => {
        const next = get();
        if (next.currentSessionKey !== resolvedSessionKey) return;
        if (resolvedRunId && next.activeRunId && next.activeRunId !== resolvedRunId) return;
        if (!next.sending && !next.pendingFinal && !next.activeRunId) return;

        const backendSnapshot = await refreshSessionBackendActivity(resolvedSessionKey);
        if (backendSnapshot) {
          set({
            sessionBackendActivity: backendSnapshot.session,
            gatewayBackgroundActivity: backendSnapshot.background,
          });
        }

        if (canClearUserTurnNow({
          messages: next.messages,
          lastUserMessageAt: next.lastUserMessageAt,
          backendActivity: backendSnapshot?.session ?? next.sessionBackendActivity,
          gatewayBackground: backendSnapshot?.background ?? next.gatewayBackgroundActivity,
          finalizeGraceStartedAt: getFinalizeGraceStartedAt(resolvedSessionKey),
        })) {
          clearFinalizeGraceTimer();
          clearHistoryPoll();
          clearErrorRecoveryTimer();
          applyClearedActiveRunForSession(set, resolvedSessionKey);
          ensureSessionBackendPolling(resolvedSessionKey, set, get);
          return;
        }

        const forceClearInput = {
          messages: next.messages,
          lastUserMessageAt: next.lastUserMessageAt,
          backendActivity: backendSnapshot?.session ?? next.sessionBackendActivity,
          gatewayBackground: backendSnapshot?.background ?? next.gatewayBackgroundActivity,
          finalizeGraceStartedAt: getFinalizeGraceStartedAt(resolvedSessionKey),
        };
        if (canForceClearOnVisibleCommittedReply(forceClearInput)) {
          clearFinalizeGraceTimer();
          clearHistoryPoll();
          clearErrorRecoveryTimer();
          applyClearedActiveRunForSession(set, resolvedSessionKey);
          ensureSessionBackendPolling(resolvedSessionKey, set, get);
          return;
        }

        if (attempt < 4) {
          window.setTimeout(() => finalizeAfterHistory(attempt + 1), 250 * (attempt + 1));
          return;
        }

        // Gateway reported completed but transcript may still be in-flight (tool rounds,
        // narration-before-tools). Do not force idle UI without a terminal assistant turn.
        set({
          streamingText: '',
          streamingMessage: null,
          streamingTools: [],
          pendingFinal: true,
          sending: next.sending
            || hasOpenDelegatedBackendWork(
              next.messages,
              backendSnapshot?.background ?? next.gatewayBackgroundActivity,
              backendSnapshot?.session ?? next.sessionBackendActivity,
            ),
          activeRunId: next.activeRunId ?? backendSnapshot?.session.activeRunIds[0] ?? null,
        });
        scheduleDelegationFinalizeGraceIfNeeded(get, set, resolvedSessionKey, {
          runId: resolvedRunId ?? undefined,
        });
        ensureSessionBackendPolling(resolvedSessionKey, set, get);
      });
    };

    finalizeAfterHistory(0);
  },

  refresh: async () => {
    const { loadHistory, loadSessions } = get();
    await Promise.all([loadHistory(), loadSessions()]);
  },

  clearError: () => set({ error: null }),

  recoverCurrentSession: async () => {
    const { currentSessionKey, emptyFinalRecovery } = get();
    const previous = emptyFinalRecovery.status === 'stale' || emptyFinalRecovery.status === 'failed'
      ? emptyFinalRecovery
      : null;
    set({
      emptyFinalRecovery: {
        status: 'recovering',
        sessionKey: currentSessionKey,
        runId: previous && 'runId' in previous ? previous.runId : null,
        reason: previous?.reason ?? 'stale-empty-final',
        diagnostic: previous?.diagnostic ?? null,
      },
    });

    try {
      const response = await recoverStaleSessionAfterEmptyFinal(currentSessionKey);
      const result = response.result;
      if (!response.success || !result) {
        const reason = response.error || 'recover-failed';
        set({
          emptyFinalRecovery: {
            status: 'failed',
            sessionKey: currentSessionKey,
            reason,
            diagnostic: previous?.diagnostic ?? null,
          },
          runError: reason,
        });
        return;
      }

      if (result.ok && result.recovered) {
        set({
          emptyFinalRecovery: {
            status: 'recovered',
            sessionKey: currentSessionKey,
            reason: result.reason,
          },
          error: null,
          runError: null,
          sending: false,
          activeRunId: null,
          pendingFinal: false,
        });
        return;
      }

      const reason = result.ok ? result.reason : result.error;
      set({
        emptyFinalRecovery: {
          status: 'failed',
          sessionKey: currentSessionKey,
          reason,
          diagnostic: previous?.diagnostic ?? null,
        },
        runError: reason,
      });
    } catch (error) {
      const reason = String(error);
      set({
        emptyFinalRecovery: {
          status: 'failed',
          sessionKey: currentSessionKey,
          reason,
          diagnostic: previous?.diagnostic ?? null,
        },
        runError: reason,
      });
    }
  },

  clearSecurityCancelNotice: () => set({ securityCancelNotice: null }),
}));

export function kickSessionBackendPolling(): void {
  const state = useChatStore.getState();
  if (!state.currentSessionKey) return;
  ensureSessionBackendPolling(state.currentSessionKey, useChatStore.setState, useChatStore.getState);
}

useChatStore.subscribe((state) => {
  persistSessionWorkspaceIdsIfChanged(state.sessionWorkspaceIds);
  persistSessionPinnedAtIfChanged(state.sessionPinnedAt);
});
