/**
 * Chat State Store
 * Manages chat messages, sessions, and streaming state.
 * Communicates with OpenClaw Gateway via renderer WebSocket RPC.
 */
import { create } from 'zustand';
import i18n from '@/i18n';
import { hostApiFetch } from '@/lib/host-api';
import { toUserMessage, normalizeAppError } from '@/lib/api-client';
import { useGatewayStore } from './gateway';
import { useAgentsStore } from './agents';
import { useWorkspacesStore } from './workspaces';
import { buildCronSessionHistoryPath, isCronSessionKey } from './chat/cron-session-utils';
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
  type SessionStreamingState,
  type ToolStatus,
} from './chat/types';
import { attachmentFileNameFromPath } from './chat/helpers';
import {
  beginChatRunPerf,
  markChatRunRpcCompleted,
  markChatRunRpcStarted,
  finishChatRunPerf,
  markChatRunRuntimeEvent,
  markChatRunTranscriptProgress,
  markChatRunVisibleProgress,
} from './chat/chat-run-perf';
import { prepareContextBeforeSend } from './chat/context-send-guard';
import { filterLargeToolResults, applyTimeDecayStrategy } from './chat/history-time-decay';
import { scheduleUiStateSync } from '@/lib/ui-state-persistence';
import { mergeDiscoveredSessionActivity, resolveSessionListActivityMs } from '@/lib/session-sidebar-order';

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

// Runs the user explicitly stopped — ignore late gateway deltas after abort clears activeRunId.
const _abortedChatRunIds = new Set<string>();

// Timestamp of the most recent user-initiated stop. Late abort-type error
// events (which may arrive after the run id was already forgotten and
// runAborted reset) are suppressed when they land within this window.
let _lastUserAbortAt = 0;
const USER_ABORT_ERROR_SUPPRESS_WINDOW_MS = 15_000;

function markUserAbort(): void {
  _lastUserAbortAt = Date.now();
}

function isWithinUserAbortWindow(): boolean {
  return _lastUserAbortAt > 0 && Date.now() - _lastUserAbortAt < USER_ABORT_ERROR_SUPPRESS_WINDOW_MS;
}

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
  /** Last real user message when leaving — merge if history lags behind the gateway. */
  fallbackUserMessage: RawMessage | null;
};

/** Preserves mid-send UI when switching sessions; cleared after resume or completion. */
let _interruptedSendSession: InterruptedSendSessionState | null = null;

// ── Silent tool stream error retry ──
// When a model produces a tool-call-stream error (list index out of range, malformed
// tool_calls, etc.), we retry ONCE silently without showing the error to the user.
// The retry replays the last sendMessage call with the same params. If it fails again,
// the user sees a friendly error message.
let _lastSendParams: { text: string; attachments?: Array<{ fileName: string; mimeType: string; fileSize: number; stagedPath: string; preview: string | null }>; targetAgentId?: string | null } | null = null;
let _retriedRunIds = new Set<string>();
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

function isReasoningMode(value: unknown): value is ReasoningMode {
  return value === 'fast' || value === 'thinking' || value === 'expert';
}

function loadStoredReasoningMode(): ReasoningMode {
  try {
    const stored = window.localStorage.getItem(REASONING_MODE_STORAGE_KEY);
    return isReasoningMode(stored) ? stored : 'fast';
  } catch {
    return 'fast';
  }
}

function persistReasoningMode(mode: ReasoningMode): void {
  try {
    window.localStorage.setItem(REASONING_MODE_STORAGE_KEY, mode);
  } catch {
    // Ignore storage failures; the current session still updates in memory.
  }
}

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

function toThinkingLevel(mode: ReasoningMode): 'off' | 'medium' | 'high' {
  if (mode === 'fast') return 'off';
  if (mode === 'expert') return 'high';
  return 'medium';
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
const ACTIVE_SEND_HISTORY_FALLBACK_INITIAL_DELAY_MS = 15_000;
const ACTIVE_SEND_HISTORY_FALLBACK_DELAYS_MS = [20_000, 30_000];
const ACTIVE_SEND_HISTORY_FALLBACK_REPEAT_MS = 30_000;
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
      if (hasLiveStreamContent(state)) return;

      try {
        await state.loadHistory(true);
      } catch (error) {
        console.warn('[chat.history-fallback] local transcript refresh failed', {
          sessionKey,
          error: String(error),
        });
      }

      const nextState = useChatStore.getState();
      if (nextState.currentSessionKey !== sessionKey || !nextState.sending) return;
      if (hasLiveStreamContent(nextState)) return;

      attempt += 1;
      const nextDelay = ACTIVE_SEND_HISTORY_FALLBACK_DELAYS_MS[attempt]
        ?? ACTIVE_SEND_HISTORY_FALLBACK_REPEAT_MS;
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

// ── Local image cache ─────────────────────────────────────────
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

/**
 * Strip Gateway-injected metadata that does NOT exist on the renderer's
 * optimistic user message but is echoed back when the Gateway persists it:
 *   - leading timestamp `[Wed 2026-04-22 10:30 GMT+8] `
 *   - `[message_id: uuid]` tags sprinkled throughout the text
 *   - `[media attached: path (mime) | path]` references appended when the
 *     renderer sends attachments via `chat:sendWithMedia`
 *   - `[Working Directory: path]` workspace context injected by the renderer
 *   - Gateway-injected "Conversation info (untrusted metadata): ..." blocks
 *
 * Keeping this aligned with `cleanUserText` in `pages/Chat/message-utils.ts`
 * is important: the user bubble renders the cleaned text, so the comparison
 * used to dedupe optimistic vs server echoes must operate on the same
 * cleaned form — otherwise the same visible message renders twice.
 */
function stripGatewayUserMetadata(text: string): string {
  return text
    .replace(/\s*\[media attached:[^\]]*\]/g, '')
    .replace(/\s*\[message_id:\s*[^\]]+\]/g, '')
    .replace(/\s*\[Working Directory:[^\]]*\]/g, '')
    .replace(/Sender\s*\([^)]*\):\s*```[a-z]*\n[\s\S]*?```\s*/gi, '')
    .replace(/Sender\s*\([^)]*\):\s*\{[\s\S]*?\}\s*/gi, '')
    .replace(/Conversation info\s*\([^)]*\):\s*```[a-z]*\n[\s\S]*?```\s*/gi, '')
    .replace(/Conversation info\s*\([^)]*\):\s*\{[\s\S]*?\}\s*/gi, '')
    .replace(/\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+[^\]]+\]\s*/gi, '')
    .trim();
}

function normalizeComparableUserText(content: unknown): string {
  let text = stripGatewayUserMetadata(getMessageText(content));
  text = maybeStripMimoDirective(text); // Strip mimo directive before comparison
  text = text.replace(/\/think\s+(off|medium|high)\s+/i, '');
  return text.replace(/\s+/g, ' ').trim();
}

function getComparableAttachmentSignature(message: Pick<RawMessage, '_attachedFiles'>): string {
  const files = (message._attachedFiles || [])
    .map((file) => file.filePath || `${file.fileName}|${file.mimeType}|${file.fileSize}`)
    .filter(Boolean)
    .sort();
  return files.join('::');
}

function matchesOptimisticUserMessage(
  candidate: RawMessage,
  optimistic: RawMessage,
  optimisticTimestampMs: number,
): boolean {
  if (candidate.role !== 'user') return false;

  const optimisticText = normalizeComparableUserText(optimistic.content);
  const candidateText = normalizeComparableUserText(candidate.content);
  const sameText = optimisticText.length > 0 && optimisticText === candidateText;

  const optimisticAttachments = getComparableAttachmentSignature(optimistic);
  const candidateAttachments = getComparableAttachmentSignature(candidate);
  const sameAttachments = optimisticAttachments.length > 0 && optimisticAttachments === candidateAttachments;

  const hasOptimisticTimestamp = Number.isFinite(optimisticTimestampMs) && optimisticTimestampMs > 0;
  const hasCandidateTimestamp = candidate.timestamp != null;
  const timestampMatches = hasOptimisticTimestamp && hasCandidateTimestamp
    ? Math.abs(toMs(candidate.timestamp as number) - optimisticTimestampMs) < 5000
    : false;

  if (sameText && sameAttachments) return true;
  if (sameText && (!optimisticAttachments || !candidateAttachments) && (timestampMatches || !hasCandidateTimestamp)) return true;
  if (sameAttachments && (!optimisticText || !candidateText) && (timestampMatches || !hasCandidateTimestamp)) return true;
  return false;
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

function getLatestOptimisticUserMessage(messages: RawMessage[], userTimestampMs: number): RawMessage | undefined {
  return [...messages].reverse().find(
    (message) => message.role === 'user' && (!message.timestamp || Math.abs(toMs(message.timestamp) - userTimestampMs) < 5000),
  );
}

/** Keep locally sent user messages when Gateway transcript has not persisted them yet (e.g. after abort). */
function mergeMissingLocalUserMessages(
  pipelineMessages: RawMessage[],
  localMessages: RawMessage[],
): RawMessage[] {
  let merged = [...pipelineMessages];
  for (const localMsg of localMessages) {
    if (localMsg.role !== 'user') continue;
    const localText = normalizeComparableUserText(localMsg.content);
    if (!localText) continue;
    const exists = merged.some(
      (message) => message.role === 'user' && normalizeComparableUserText(message.content) === localText,
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
      const optimisticText = normalizeComparableUserText(optimistic.content);
      const hasMatchingUser = optimisticText.length > 0
        ? finalMessages.some((message) => {
            if (message.role !== 'user') return false;
            return normalizeComparableUserText(message.content) === optimisticText;
          })
        : false;
      if (!hasMatchingUser) {
        finalMessages = [...finalMessages, optimistic];
      }
    }
  }

  if (finalMessages.length > 0) return finalMessages;
  if (state.messages.length > 0) return state.messages;

  const snapshot = state.sessionStreamingStates[sessionKey]?.messagesSnapshot;
  if (snapshot && snapshot.length > 0) return snapshot;

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
    ids.push(String(message.id ?? `${message.role}:${timestamp ?? ids.length}`));
  }

  if (messageCount === 0) return null;
  return {
    messageCount,
    assistantCount,
    toolResultCount,
    latestTimestamp,
    signature: `${messageCount}|${assistantCount}|${toolResultCount}|${toolUseCount}|${thinkingCount}|${assistantTextCount}|${latestTimestamp ?? 'na'}|${ids.join(',')}`,
    visibleKind,
    toolUseCount,
    thinkingCount,
    assistantTextCount,
  };
}

/** Extract media file refs from [media attached: <path> (<mime>) | ...] patterns */
function extractMediaRefs(text: string): Array<{ filePath: string; mimeType: string }> {
  const refs: Array<{ filePath: string; mimeType: string }> = [];
  const regex = /\[media attached:\s*([^\s(]+)\s*\(([^)]+)\)\s*\|[^\]]*\]/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    refs.push({ filePath: match[1], mimeType: match[2] });
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
  // Unix absolute paths (/... or ~/...) — lookbehind rejects mid-token slashes
  // (e.g. "path/to/file.mp4", "https://example.com/file.mp4")
  const unixRegex = new RegExp(`(?<![\\w./:])((?:\\/|~\\/)[^\\s\\n"'()\\[\\],<>]*?\\.(?:${exts}))`, 'gi');
  // Windows absolute paths (C:\... D:\...) — lookbehind rejects drive letter glued to a word
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

  // Anthropic/normalized format — toolCall blocks in content array
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

  // OpenAI format — tool_calls array on the message itself
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

    // Path 1: [media attached: path (mime) | path] — guaranteed format from attachment button
    const mediaRefs = extractMediaRefs(text);
    const mediaRefPaths = new Set(mediaRefs.map(r => r.filePath));

    // Path 2: Raw file paths.
    // For assistant messages: scan own text AND the nearest preceding user message text,
    // but only for non-tool-only assistant messages (i.e. the final answer turn).
    // Tool-only messages (thinking + tool calls) should not show file previews — those
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

    // Path 2: [media attached: ...] patterns (legacy — in case filePath wasn't stored)
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
    ? String(record.firstUserMessagePreview)
    : undefined;

  return {
    key,
    label: firstUserMessagePreview || (record.label ? String(record.label) : undefined),
    firstUserMessagePreview,
    displayName: record.displayName ? String(record.displayName) : undefined,
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
      .filter((session) => session.label)
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

/** Empty `:main` is a shared scratchpad — promote to a dedicated session key before the first send. */
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

  // Save the current session's streaming state before switching.
  // Also preserve the current visible messages snapshot so completed sessions
  // can restore immediately when switched back, even if no stream is active.
  const hasActiveStreaming = state.activeRunId || state.sending;
  const shouldSnapshotMessages = hasActiveStreaming || state.messages.length > 0;
  const savedStreamingStates: Record<string, SessionStreamingState> = {
    ...state.sessionStreamingStates,
    [state.currentSessionKey]: {
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
      messagesSnapshot: shouldSnapshotMessages ? [...state.messages] : [],
    },
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
    sessionStreamingStates: finalStreamingStates,
    // Restore messages snapshot if there's an active stream, otherwise clear for loadHistory
    messages: nextSessionState.messagesSnapshot.length > 0 ? nextSessionState.messagesSnapshot : [],
    error: null,
    // Restore streaming state from the next session
    activeRunId: nextSessionState.activeRunId,
    streamingText: nextSessionState.streamingText,
    streamingMessage: nextSessionState.streamingMessage,
    streamingTools: nextSessionState.streamingTools,
    pendingFinal: nextSessionState.pendingFinal,
    lastUserMessageAt: nextSessionState.lastUserMessageAt,
    pendingToolImages: nextSessionState.pendingToolImages,
    runAborted: nextSessionState.runAborted,
    runError: nextSessionState.runError ?? null,
    sending: nextSessionState.sending,
    loading: false,
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
    // Content is not an array — check if there's OpenAI-format tool_calls
    if (hasOpenAITools) {
      // Has tool calls but content might be empty/string — treat as tool-only
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
    // Thinking blocks are internal reasoning that can accompany tool_use — they
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
  if (/^(HEARTBEAT_OK|NO_REPLY)\s*$/.test(text.trim())) return true;
  return isRuntimeSystemInjection(text);
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
 *   - "System (untrusted): ..." — exec results, tool output, etc.
 *   - "An async command ... has completed" — async completion notices
 *   - "Current time: ..." followed by nothing else — periodic heartbeat time pings
 *   - "Handle the result internally. Do not relay it to the user" — internal directives
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

  // Path 1: Anthropic/normalized format — tool blocks inside content array
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

  // Path 2: OpenAI format — tool_calls array on the message itself
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
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
    if (candidate && typeof candidate === 'object') {
      const record = candidate as Record<string, unknown>;
      const nested = record.errorMessage ?? record.error_message ?? record.error;
      if (typeof nested === 'string' && nested.trim()) return nested;
    }
  }

  return 'An error occurred';
}

function isTerminalAssistantErrorMessage(message: RawMessage | undefined): boolean {
  if (!message || message.role !== 'assistant') return false;
  const msg = message as RawMessage & { stopReason?: unknown; stop_reason?: unknown };
  return (msg.stopReason ?? msg.stop_reason) === 'error';
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

function isTerminalAssistantMessage(message: RawMessage | undefined): boolean {
  if (!message || message.role !== 'assistant') return false;
  if (!hasNonToolAssistantContent(message)) return false;

  const msg = message as RawMessage & { stopReason?: unknown; stop_reason?: unknown };
  const stopReason = msg.stopReason ?? msg.stop_reason;
  // Transcript polling is observational and may catch an assistant message
  // while it is still being persisted. Only an explicit stop reason is strong
  // enough to close the active run from history.
  if (stopReason == null) return false;

  const normalized = String(stopReason).toLowerCase();
  return normalized !== 'tooluse'
    && normalized !== 'tool_use'
    && normalized !== 'tool-call'
    && normalized !== 'tool_calls';
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
  const ta = getMessageText(a.content).trim();
  const tb = getMessageText(b.content).trim();
  return Boolean(ta && tb && ta === tb);
}

/** Text/image reply only — excludes thinking-only snapshots so we can still show “waiting” UI. */
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
 * stale `sending`/`activeRunId` snapshot leaves the session stuck on
 * "thinking…" forever and blocks the switch-back `loadHistory` that would
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

// ── Store ────────────────────────────────────────────────────────

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  loading: false,
  error: null,
  runError: null,
  securityCancelNotice: null,
  prefilledInput: null,
  sending: false,
  aborting: false,
  activeRunId: null,
  streamingText: '',
  streamingMessage: null,
  streamingTools: [],
  pendingFinal: false,
  lastUserMessageAt: null,
  pendingToolImages: [],
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
  thinkingLevel: null,
  reasoningMode: loadStoredReasoningMode(),

  setReasoningMode: async (mode: ReasoningMode) => {
    persistReasoningMode(mode);
    set({ reasoningMode: mode });
    const { needsPatch } = applySessionThinkingLevelInBackground(get().currentSessionKey, mode, set);
    if (needsPatch) {
      deferSessionThinkingLevelPatch(get().currentSessionKey, mode);
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

  // ── Load sessions via sessions.list ──
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
              const mergedLocal = mergePreservedSessionsIntoGatewayList(sessions, get());
              
              const { currentSessionKey } = get();
              const nextSessionKey = currentSessionKey || DEFAULT_SESSION_KEY;
              
              // 从 updatedAt 填充 sessionLastActivity，防止会话被误判为空会话
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
            localPreviewSessions = await loadLocalSessionSummaries('main');
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

          const mergedWithPreserved = mergePreservedSessionsIntoGatewayList(dedupedSessions, get());

          const { currentSessionKey, sessions: localSessions } = get();
          let nextSessionKey = currentSessionKey || DEFAULT_SESSION_KEY;
          if (!nextSessionKey.startsWith('agent:')) {
            const canonicalMatch = canonicalBySuffix.get(nextSessionKey);
            if (canonicalMatch) {
              nextSessionKey = canonicalMatch;
            }
          }
          if (!mergedWithPreserved.find((s) => s.key === nextSessionKey) && mergedWithPreserved.length > 0) {
            // Preserve only locally-created pending sessions. On initial boot the
            // default ghost key (`agent:main:main`) should yield to real history.
            const hasLocalPendingSession = localSessions.some((session) => session.key === nextSessionKey);
            if (!hasLocalPendingSession) {
              nextSessionKey = mergedWithPreserved[0].key;
            }
          }

          const sessionsWithCurrent = !mergedWithPreserved.find((s) => s.key === nextSessionKey) && nextSessionKey
            ? [
              ...mergedWithPreserved,
              { key: nextSessionKey, displayName: nextSessionKey },
            ]
            : mergedWithPreserved;

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

  // ── Switch session ──

  switchSession: (key: string) => {
    if (key === get().currentSessionKey) return;
    // Stop any background polling for the old session before switching.
    // This prevents the poll timer from firing after the switch and loading
    // the wrong session's history into the new session's view.
    clearHistoryPoll();
    const prev = get();
    if (prev.sending && prev.currentSessionKey !== key) {
      _interruptedSendSession = {
        sessionKey: prev.currentSessionKey,
        activeRunId: prev.activeRunId,
        lastUserMessageAt: prev.lastUserMessageAt,
        fallbackUserMessage: getLastRealUserSnapshot(prev.messages),
      };
    }
    const { sessionStreamingStates } = get();
    const nextState = sessionStreamingStates[key];
    const hasActiveStream = nextState?.activeRunId || nextState?.sending;
    set((s) => buildSessionSwitchPatch(s, key));
    syncWorkspacePickerToSession(get().sessionWorkspaceIds, key);
    if (!hasActiveStream) {
      get().loadHistory();
    }
  },

  // ── Delete session ──
  //
  // NOTE: The OpenClaw Gateway does NOT expose a sessions.delete (or equivalent)
  // RPC — confirmed by inspecting client.ts, protocol.ts and the full codebase.
  // Deletion is therefore a local-only UI operation: the session is removed from
  // the sidebar list and its labels/activity maps are cleared.  The underlying
  // JSONL history file on disk is intentionally left intact, consistent with the
  // newSession() design that avoids sessions.reset to preserve history.

  deleteSession: async (key: string) => {
    // Soft-delete the session's JSONL transcript on disk.
    // The main process renames <suffix>.jsonl → <suffix>.deleted.jsonl so that
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

    const { currentSessionKey, sessions } = get();
    const remaining = sessions.filter((s) => s.key !== key);

    if (currentSessionKey === key) {
      // Switched away from deleted session — pick the first remaining or create new
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
        };
      });
    }
  },

  // ── Rename session (persisted user-edited title) ──
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

  // ── New session ──

  newSession: () => {
    // Generate a new unique session key and switch to it.
    // NOTE: We intentionally do NOT call sessions.reset on the old session.
    // sessions.reset archives (renames) the session JSONL file, making old
    // conversation history inaccessible when the user switches back to it.
    const { currentSessionKey, messages, sessions, sessionLastActivity, sessionLabels, activeRunId, streamingText, streamingMessage, streamingTools, pendingFinal, lastUserMessageAt, pendingToolImages, runAborted, sending } = get();
    // Only treat sessions with no history records and no activity timestamp as empty
    const leavingEmpty = !currentSessionKey.endsWith(':main')
      && messages.length === 0
      && !sessionLastActivity[currentSessionKey]
      && !sessionLabels[currentSessionKey];
    const prefix = getCanonicalPrefixFromSessionKey(currentSessionKey)
      ?? getCanonicalPrefixFromSessions(sessions)
      ?? DEFAULT_CANONICAL_PREFIX;
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
          messagesSnapshot: hasActiveStreaming ? [...messages] : [],
        },
      };
      // Remove streaming state if leaving an empty session
      const finalStreamingStates = leavingEmpty
        ? clearSessionEntryFromMap(nextStreamingStates, currentSessionKey)
        : nextStreamingStates;

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
      };
    });
    syncWorkspacePickerToSession(get().sessionWorkspaceIds, newKey);
    // Match switchSession: pull history for the new key immediately. Relying only on
    // Chat's useEffect can strand the UI if `loading` stayed true from a prior session
    // (effect guards on `!loading`) or if the user expects the same load path as a
    // sidebar session switch.
    void get().loadHistory();
  },

  // ── Set prefilled input text ──

  setPrefilledInput: (text: string | null) => {
    set((s) => ({ ...s, prefilledInput: text }));
  },

  // ── Cleanup empty session on navigate away ──

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
      };
    });
  },

  // ── Load chat history ──

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

    // If the RPC never settles (hang), we must drop the in-flight entry — otherwise
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

      const applyLoadedMessages = (
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
      const filteredMessages = messagesWithToolImages.filter((msg) => !isToolResultRole(msg.role) && !isInternalMessage(msg));
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

      set({ messages: finalMessages, thinkingLevel });

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

      // If we're sending but haven't received streaming events, check
      // whether the loaded history reveals intermediate tool-call activity.
      // This surfaces progress via the pendingFinal → ActivityIndicator path.
      // But skip this if there's an active run, as streaming state should be preserved.
      const userMsTs = lastUserMessageAt ? toMs(lastUserMessageAt) : 0;
      const isAfterUserMsg = (msg: RawMessage): boolean => {
        if (!userMsTs || !msg.timestamp) return true;
        return toMs(msg.timestamp) >= userMsTs;
      };

      const recentTerminalAssistant = [...finalMessages].reverse().find((msg) => {
        if (msg.role !== 'assistant') return false;
        if (!isTerminalAssistantMessage(msg)) return false;
        return isAfterUserMsg(msg);
      });

      if (isSendingNow && recentTerminalAssistant) {
        clearHistoryPoll();
        clearErrorRecoveryTimer();
        set({
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
        finishChatRunPerf('history-final', currentActiveRunId ?? '');
      } else if (isSendingNow && !pendingFinal && !currentActiveRunId) {
        const hasRecentAssistantActivity = [...finalMessages].reverse().some((msg) => {
          if (msg.role !== 'assistant') return false;
          return isAfterUserMsg(msg);
        });
        if (hasRecentAssistantActivity) {
          set({ pendingFinal: true });
        }
      }

      const latestPromptError = getLatestPromptErrorAfterUser(promptErrors, userMsTs);
      if (latestPromptError) {
        const promptErrorAt = getPromptErrorTimestamp(latestPromptError);
        const terminalAfterPromptError = [...finalMessages].reverse().some((msg) => {
          if (!isTerminalAssistantMessage(msg)) return false;
          if (!promptErrorAt || !msg.timestamp) return false;
          return toMs(msg.timestamp) >= promptErrorAt;
        });
        if (!terminalAfterPromptError) {
          clearHistoryPoll();
          clearErrorRecoveryTimer();
          set({
            error: typeof latestPromptError.error === 'string'
              ? latestPromptError.error
              : i18n.t('chat:errors.modelResponseTimeoutLong'),
            sending: false,
            activeRunId: null,
            pendingFinal: false,
            streamingText: '',
            streamingMessage: null,
            streamingTools: [],
            pendingToolImages: [],
            lastUserMessageAt: null,
            runAborted: true,
          });
        }
      }
      return true;
      };

      const recordTranscriptProgress = (
        rawMessages: RawMessage[],
        source: 'local-history' | 'gateway-history',
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

        markChatRunTranscriptProgress({
          runId: state.activeRunId,
          source,
          ...progress,
        });
        if (progress.visibleKind) {
          markChatRunVisibleProgress({
            runId: state.activeRunId,
            source: 'transcript',
            kind: progress.visibleKind,
          });
        }
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
              const rawMessages = response.messages;
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

                const applied = applyLoadedMessages(decayResult.messages, thinkingLevel, response.promptErrors ?? []);
                if (decayResult.stats.finalCount < decayResult.stats.originalCount) {
                  console.log(`[history-time-decay] ${currentSessionKey}: ${decayResult.stats.originalCount}→${decayResult.stats.finalCount} messages, ~${decayResult.stats.estimatedTokens} tokens (${decayResult.stats.hoursAgo.toFixed(1)}h ago)`);
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
          if (rawMessages.length === 0 && isCronSessionKey(currentSessionKey)) {
            rawMessages = await loadCronFallbackMessages(currentSessionKey, 200);
          }

          // Apply compression reconstruction or time decay
          const compressionState = get().sessionCompressionState?.[currentSessionKey] ?? null;
          const hasCachedCompression = compressionState && !compressionState.isTruncation
            && rawMessages.length >= compressionState.totalMessagesAtCompression;
          const preMessages = hasCachedCompression
            ? reconstructCompressedView(rawMessages, compressionState!)
            : rawMessages;
          const decayResult = applyTimeDecayStrategy(preMessages, get().sessionLastActivity[currentSessionKey], hasCachedCompression ?? false);

          const applied = applyLoadedMessages(decayResult.messages, thinkingLevel);
          if (decayResult.stats.finalCount < decayResult.stats.originalCount) {
            console.log(`[history-time-decay] ${currentSessionKey}: ${decayResult.stats.originalCount}→${decayResult.stats.finalCount} messages, ~${decayResult.stats.estimatedTokens} tokens (${decayResult.stats.hoursAgo.toFixed(1)}h ago)`);
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
            const applied = applyLoadedMessages(fallbackMessages, null);
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
          const applied = applyLoadedMessages(fallbackMessages, null);
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

  // ── Send message ──

  sendMessage: async (
    text: string,
    attachments?: Array<{ fileName: string; mimeType: string; fileSize: number; stagedPath: string; preview: string | null }>,
    targetAgentId?: string | null,
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
        set({ error: `@${targetAgentId} 不是已安装的数字员工，当前 @agent 只支持数字员工。`, sending: false });
        return;
      }
    }
    const trimmed = text.trim();
    if (!trimmed && (!attachments || attachments.length === 0)) return;

    clearAbortedChatRuns();

    const targetSessionKey = resolveMainSessionKeyForAgent(_deAgentId) ?? get().currentSessionKey;

    if (targetSessionKey !== get().currentSessionKey) {
      set((s) => buildSessionSwitchPatch(s, targetSessionKey));
      syncWorkspacePickerToSession(get().sessionWorkspaceIds, targetSessionKey);
      await get().loadHistory(true);
    }

    let currentSessionKey = get().currentSessionKey;
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
      _agentMention: targetAgentId || void 0,
      _agentMentionName: _deDisplayName || targetAgentId || void 0,
      _attachedFiles: attachments?.map(a => ({
        fileName: a.fileName,
        mimeType: a.mimeType,
        fileSize: a.fileSize,
        preview: a.preview,
        filePath: a.stagedPath,
      })),
    };

    // Save send params for potential silent retry
    _lastSendParams = { text, attachments, targetAgentId };
    _retriedRunIds = new Set();

    const contextGuard = await prepareContextBeforeSend({
      sessionKey: currentSessionKey,
      messages: get().messages,
      pendingUserMessage: userMsg,
      runtimeMessage,
      workspaceContext,
      isInternalStagedExecution,
      invokeCompactorRpc: (method, params, timeoutMs) => useGatewayStore.getState().rpc(method, params as Record<string, unknown>, timeoutMs),
      persistedCompressionState: get().sessionCompressionState?.[currentSessionKey] ?? null,
    });

    if (contextGuard.error) {
      set({ error: contextGuard.errorMessage ?? String(contextGuard.error), sending: false });
      return;
    }

    if (contextGuard.compressed) {
      const nextCompressionState = contextGuard.compressionMeta
        ? { ...get().sessionCompressionState, [currentSessionKey]: contextGuard.compressionMeta }
        : get().sessionCompressionState;
      set({ messages: contextGuard.messages, sessionCompressionState: nextCompressionState });
      scheduleUiStateSync();
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
      const nextMessages = isInternalStagedExecution ? s.messages : [...s.messages, userMsg];
      const prevStream = s.sessionStreamingStates[currentSessionKey] ?? createEmptySessionStreamingState();
      return {
        messages: nextMessages,
        sending: true,
        error: null,
        streamingText: '',
        streamingMessage: null,
        streamingTools: [],
        pendingFinal: false,
        lastUserMessageAt: nowMs,
        isFirstMessageEver: _isFirstMessageEver, // Store flag in state for UI access
        runAborted: false,
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
    // entire agentic conversation finishes — the poll must run in parallel.
    _lastChatEventAt = Date.now();
    clearHistoryPoll();
    clearErrorRecoveryTimer();
    _lastRuntimeTranscriptProgressSignatureBySession.delete(currentSessionKey);
    startActiveSendHistoryFallback(currentSessionKey);

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
      const state = get();
      if (!state.sending) return;
      if (hasLiveStreamContent(state)) return;
      const idleMs = Date.now() - _lastChatEventAt;
      if (state.streamingMessage || state.streamingText) {
        if (idleMs < STREAMING_STALE_HISTORY_REFRESH_MS) {
          setTimeout(checkStuck, 10_000);
          return;
        }
        if (Date.now() - lastStreamingHistoryRefreshAt >= STREAMING_STALE_HISTORY_REFRESH_MS) {
          lastStreamingHistoryRefreshAt = Date.now();
          void state.loadHistory(true);
        }
        if (idleMs >= STREAMING_STALE_HARD_TIMEOUT_MS) {
          const currentStream = get().streamingMessage as RawMessage | null;
          const streamSnapshot = snapshotStreamingAssistantMessage(
            currentStream,
            get().messages,
            `stale-${state.activeRunId || Date.now()}`,
          );
          clearHistoryPoll();
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
      if (state.pendingFinal) {
        if (idleMs >= PENDING_FINAL_HISTORY_REFRESH_MS && Date.now() - lastPendingFinalHistoryRefreshAt >= PENDING_FINAL_HISTORY_REFRESH_MS) {
          lastPendingFinalHistoryRefreshAt = Date.now();
          void state.loadHistory(true);
        }
        if (idleMs >= PENDING_FINAL_HARD_TIMEOUT_MS) {
          clearHistoryPoll();
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
      clearHistoryPoll();
      abortGatewayRun(currentSessionKey);
      _pendingComplexTaskPlans.delete(currentSessionKey);
      set({
        error: i18n.t('chat:errors.modelResponseTimeout'),
        sending: false,
        activeRunId: null,
        lastUserMessageAt: null,
      });
    };
    setTimeout(checkStuck, 30_000);

    const idempotencyKey = crypto.randomUUID();
    if (_deIsDigital && targetAgentId) {
      _digitalEmployeeRuns.set(idempotencyKey, {
        agentId: targetAgentId,
        name: _deDisplayName || targetAgentId,
      });
    }
    try {
      const firstSessionPerfMethod = hasMedia ? 'chat.sendWithMedia' : 'chat.send';
      beginChatRunPerf({
        localId: idempotencyKey,
        sessionKey: currentSessionKey,
        method: firstSessionPerfMethod,
        selectedReasoningMode: reasoningMode,
        effectiveReasoningMode,
        messageLength: trimmed.length,
        hasMedia,
        attachmentCount: attachments?.length ?? 0,
        isMainSession: currentSessionKey.endsWith(':main'),
        reasoningOverrideReason: reasoningDecision.reason,
        reasoningOverrideRule: reasoningDecision.rule,
        reasoningOverrideConfidence: reasoningDecision.confidence,
      });
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
      markChatRunRpcStarted(idempotencyKey);
      const messageForGateway = withThinkingDirective(
        runtimeMessage + (_deIsDigital ? '' : workspaceContext),
        effectiveReasoningMode,
      );
      const executeAsParams = _deIsDigital && targetAgentId
        ? {
          executeAsAgentId: targetAgentId,
          executedByAgentName: _deDisplayName || targetAgentId,
        }
        : {};

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
              ...executeAsParams,
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
          ...executeAsParams,
        };
        const rpcResult = await useGatewayStore.getState().rpc<{ runId?: string }>(
          'chat.send',
          chatSendParams,
          CHAT_SEND_TIMEOUT_MS,
        );
        result = { success: true, result: rpcResult };
      }

      markChatRunRpcCompleted(idempotencyKey, {
        success: result.success,
        runId: result.result?.runId ?? null,
        error: result.error,
      });
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
        if (_deIsDigital && targetAgentId) {
          _digitalEmployeeRuns.set(runId, {
            agentId: targetAgentId,
            name: _deDisplayName || targetAgentId,
          });
        }
        const pendingPlan = _pendingComplexTaskPlans.get(currentSessionKey);
        if (pendingPlan) {
          _pendingComplexTaskPlans.set(currentSessionKey, {
            ...pendingPlan,
            planningRunId: runId,
          });
        }
        set((s) => ({
          activeRunId: runId,
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
      markChatRunRpcCompleted(idempotencyKey, {
        success: false,
        error: errStr,
      });
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

  // ── Abort active run ──

  abortRun: async () => {
    clearHistoryPoll();
    clearErrorRecoveryTimer();
    const { currentSessionKey, messages, activeRunId } = get();
    markUserAbort();
    if (activeRunId) {
      markAbortedChatRun(activeRunId);
    }
    if (_interruptedSendSession?.sessionKey === currentSessionKey) {
      _interruptedSendSession = null;
    }
    const lastUser = getLastRealUserSnapshot(messages);
    const workspaceId = useWorkspacesStore.getState().currentWorkspaceId;
    set((s) => ({
      ...buildSessionRegistrationPatch(s, currentSessionKey, lastUser, workspaceId),
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
          messagesSnapshot: messages.length > 0 ? [...messages] : (s.sessionStreamingStates[currentSessionKey]?.messagesSnapshot ?? []),
          sending: false,
          runAborted: true,
          activeRunId: null,
        },
      },
    }));

    try {
      await useGatewayStore.getState().rpc(
        'sessions.abort',
        {
          key: currentSessionKey,
          ...(activeRunId ? { runId: activeRunId } : {}),
        },
        10_000,
      );
    } catch (err) {
      // 忽略 abort 错误，因为用户主动终止会话时 RPC 可能被中止
      const errStr = String(err);
      if (!errStr.includes('aborted') && !errStr.includes('abort')) {
        set({ error: errStr });
      }
    }
  },

  // ── Handle incoming chat events from Gateway ──

  handleChatEvent: (event: Record<string, unknown>) => {
    const runId = String(event.runId || '');
    const eventState = String(event.state || '');
    const eventSessionKey = event.sessionKey != null ? String(event.sessionKey) : null;
    const { activeRunId, currentSessionKey } = get();
    const isCurrentSessionEvent = eventSessionKey == null || eventSessionKey === currentSessionKey;

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

      if (runId && isAbortedChatRun(runId)) {
        if (backgroundState === 'aborted' || backgroundState === 'final' || backgroundState === 'error') {
          forgetAbortedChatRun(runId);
        } else {
          return;
        }
      }

      const nextSessionStreamingStates = applyBackgroundChatEvent(get(), eventSessionKey, event, backgroundState, runId);
      if (nextSessionStreamingStates) {
        set({ sessionStreamingStates: nextSessionStreamingStates });
      }
      return;
    }

    // Approval followups resume the same user-visible run with a synthetic
    // runId. Let those continuation events close the current session state.
    if (!shouldProcessCurrentSessionRunEvent(activeRunId, runId)) return;

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

    // Events for a session the user isn't currently viewing must not mutate the
    // visible streaming fields. We still finalize that background session's
    // saved streaming state when its run completes, otherwise switching back
    // strands it on a frozen "thinking…" indicator and blocks the loadHistory
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

    const { runAborted, sending: isSending } = get();
    if (runAborted && !isSending && (resolvedState === 'delta' || resolvedState === 'started')) {
      return;
    }

    markChatRunRuntimeEvent({
      state: resolvedState,
      runId,
      hasMessage: Boolean(event.message),
    });

    const visibleProgress = classifyVisibleProgress(event.message);
    if (visibleProgress.visible) {
      markChatRunVisibleProgress({
        runId,
        source: 'stream',
        kind: visibleProgress.kind,
        state: resolvedState,
        messageBlockTypes: visibleProgress.messageBlockTypes,
      });
    }

    // Only pause the history poll when we receive user-visible streaming data
    // or a terminal event. Placeholder deltas must not kill the fallback poll.
    const hasTerminalData = resolvedState === 'final' || resolvedState === 'error' || resolvedState === 'aborted';
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
              if (msgContent.trim() && isInternalMessageText(msgContent)) {
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
        clearErrorRecoveryTimer();
        if (get().error) set({ error: null });
        // Message complete - add to history and clear streaming
        const finalMsg = event.message as RawMessage | undefined;
        if (finalMsg) {
          const normalizedFinalMessage = annotateDigitalEmployeeMessage(
            normalizeStreamingMessage(finalMsg) as RawMessage,
            runId,
          ) as RawMessage;

          // ── Silent retry for tool stream errors ──
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

                // Abort the failed run on gateway
                abortGatewayRun(currentSessionKey);

                // Retry immediately (small delay so the abort RPC propagates)
                setTimeout(() => {
                  const state = get();
                  if (!state.sending || state.currentSessionKey !== currentSessionKey) return;
                  const params = _lastSendParams!;
                  void state.sendMessage(params.text, params.attachments, params.targetAgentId);
                }, 100);

                // Don't snapshot the failed message, don't set error, don't loadHistory
                break;
              }
            }
          }

          if (isTerminalAssistantErrorMessage(normalizedFinalMessage)) {
            const messageError = getMessageErrorMessage(normalizedFinalMessage);
            clearHistoryPoll();
            if (isUserSecurityDenialMessage(messageError)) {
              finishChatRunPerf('cancelled', runId);
              set(buildSecurityDenialState(messageError));
              break;
            }
            set({
              streamingText: '',
              streamingMessage: null,
              sending: false,
              activeRunId: null,
              pendingFinal: false,
              runError: messageError,
            });
            break;
          }

          const finalMsgContent = getMessageText(normalizedFinalMessage.content);
          if (finalMsgContent.trim() && isInternalMessageText(finalMsgContent)) {
            set((s) => ({
              streamingText: '',
              streamingMessage: s.streamingMessage,
              sending: false,
              activeRunId: null,
              pendingFinal: false,
            }));
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
              // events for intermediate tool-use turns — it only sends deltas and then the
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
          const intermediateToolStep = toolOnly || hasToolInvocation(normalizedFinalMessage);
          const hasOutput = hasNonToolAssistantContent(normalizedFinalMessage);
          const keepRunActiveAfterFinal = intermediateToolStep && !isExecApprovalFollowupRun(runId);
          const msgId = normalizedFinalMessage.id || (intermediateToolStep ? `run-${runId}-tool-${Date.now()}` : `run-${runId}`);
          set((s) => {
            const nextTools = updates.length > 0 ? upsertToolStatuses(s.streamingTools, updates) : s.streamingTools;
            const streamingTools = hasOutput && !intermediateToolStep ? [] : nextTools;

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
            const alreadyExists = s.messages.some(m => m.id === msgId);
            if (alreadyExists) {
              return keepRunActiveAfterFinal ? {
                streamingText: '',
                streamingMessage: null,
                pendingFinal: true,
                streamingTools,
                ...clearPendingImages,
              } : {
                streamingText: '',
                streamingMessage: null,
                sending: hasOutput ? false : s.sending,
                activeRunId: hasOutput ? null : s.activeRunId,
                pendingFinal: hasOutput ? false : true,
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
              ...clearPendingImages,
            } : {
              messages: [...s.messages, msgWithImages],
              streamingText: '',
              streamingMessage: null,
              sending: hasOutput ? false : s.sending,
              activeRunId: hasOutput ? null : s.activeRunId,
              pendingFinal: hasOutput ? false : true,
              streamingTools,
              ...clearPendingImages,
            };
          });
          // After the final response, quietly reload history to surface all intermediate
          // tool-use turns (thinking + tool blocks) from the Gateway's authoritative record.
          if (hasOutput && !intermediateToolStep) {
            clearHistoryPoll();
            void get().loadHistory(true, { force: true });
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
          }
        } else {
          set({
            sending: false,
            activeRunId: null,
            streamingText: '',
            streamingMessage: null,
            streamingTools: [],
            pendingFinal: false,
            pendingToolImages: [],
            lastUserMessageAt: null,
          });
          void get().loadHistory(true, { force: true });
        }
        break;
      }
      case 'error': {
        const rawErrorMsg = String(event.errorMessage || 'An error occurred');

        // ── User-initiated stop ──
        // When the user clicks the stop button, the runtime may still emit an
        // `error` event carrying an "abort" message. Treat that as a clean stop
        // and suppress the error bar instead of surfacing it to the user.
        // The terminal `aborted` event can arrive first (clearing runAborted and
        // forgetting the run id), so we also honor a short post-stop time window.
        const isAbortError = rawErrorMsg.toLowerCase().includes('abort');
        if (isAbortError && (wasUserAbortedRun || get().runAborted || isWithinUserAbortWindow())) {
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

        // ── Silent retry for tool stream errors ──
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

          // Abort failed run
          abortGatewayRun(currentSessionKey);

          // Retry after short delay
          setTimeout(() => {
            const state = get();
            if (!state.sending || state.currentSessionKey !== currentSessionKey) return;
            const params = _lastSendParams!;
            void state.sendMessage(params.text, params.attachments, params.targetAgentId);
          }, 100);
          break;
        }
        const errorMsg = getRuntimeEventErrorMessage(event);
        const wasSending = get().sending;
        if (isUserSecurityDenialMessage(errorMsg)) {
          clearErrorRecoveryTimer();
          clearHistoryPoll();
          finishChatRunPerf('cancelled', runId);
          _pendingComplexTaskPlans.delete(currentSessionKey);
          set(buildSecurityDenialState(errorMsg));
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

        set({
          error: errorMsg,
          streamingText: '',
          streamingMessage: null,
          streamingTools: [],
          pendingFinal: false,
          pendingToolImages: [],
        });

        // Don't immediately give up: the Gateway often retries internally
        // after transient API failures (e.g. "terminated"). Keep `sending`
        // true for a grace period so that recovery events are processed and
        // the agent-phase-completion handler can still trigger loadHistory.
        if (wasSending) {
          clearErrorRecoveryTimer();
          const ERROR_RECOVERY_GRACE_MS = 15_000;
          _errorRecoveryTimer = setTimeout(() => {
            _errorRecoveryTimer = null;
            const state = get();
            if (state.sending && !state.streamingMessage) {
              clearHistoryPoll();
              finishChatRunPerf('error', runId);
              // Grace period expired with no recovery — finalize the error
              set({
                sending: false,
                activeRunId: null,
                lastUserMessageAt: null,
              });
              // One final history reload in case the Gateway completed in the
              // background and we just missed the event.
              state.loadHistory(true);
            }
          }, ERROR_RECOVERY_GRACE_MS);
        } else {
          clearHistoryPoll();
          finishChatRunPerf('error', runId);
          set({ sending: false, activeRunId: null, lastUserMessageAt: null });
        }
        break;
      }
      case 'aborted': {
        clearHistoryPoll();
        clearErrorRecoveryTimer();
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
        }));
        break;
      }
      default: {
        // Unknown or empty state — if we're currently sending and receive an event
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
  refresh: async () => {
    const { loadHistory, loadSessions } = get();
    await Promise.all([loadHistory(), loadSessions()]);
  },

  clearError: () => set({ error: null }),

  clearSecurityCancelNotice: () => set({ securityCancelNotice: null }),
}));

useChatStore.subscribe((state) => {
  persistSessionWorkspaceIdsIfChanged(state.sessionWorkspaceIds);
  persistSessionPinnedAtIfChanged(state.sessionPinnedAt);
});
