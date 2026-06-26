import i18n from '@/i18n';
import { invokeIpc } from '@/lib/api-client';
import { recoverStaleSessionAfterEmptyFinal } from '@/lib/host-api';
import { useAgentsStore } from '@/stores/agents';
import {
  clearAbortedChatRuns,
  clearErrorRecoveryTimer,
  clearHistoryPoll,
  dedupeEquivalentAttachmentUserMessages,
  getLastChatEventAt,
  markAbortedChatRun,
  markAbortHistoryQuietPeriod,
  markUserAbort,
  isUserSecurityDenialMessage,
  buildSecurityCancelNotice,
  setLastChatEventAt,
  upsertImageCacheEntry,
} from './helpers';

import type { ChatSession, RawMessage, ReasoningMode } from './types';
import { buildClearedActiveRunPatch } from './run-lifecycle';
import { refreshSessionBackendActivity } from './session-backend-bridge';
import { shouldForceAbortStuckRun } from './user-turn-lifecycle';
import { abortPendingChildDelegations } from './abort-child-delegations';
import { persistUserAbortedSession } from './user-aborted-sessions';
import { prepareContextBeforeSend } from './context-send-guard';
import type { ChatGet, ChatSet, RuntimeActions } from './store-api';
import {
  bindRunIdToObservation,
  createRunawayToolObservation,
  detectTaskWorkflowKind,
} from './runaway-tool-observer';
import { buildInitialConvergenceSystemPrompt } from './task-convergence-strategy';
import { clearToolWatchdogsForRun } from './tool-lifecycle-watchdog';

function normalizeAgentId(value: string | undefined | null): string {
  return (value ?? '').trim().toLowerCase() || 'main';
}

function getAgentIdFromSessionKey(sessionKey: string): string {
  if (!sessionKey.startsWith('agent:')) return 'main';
  const [, agentId] = sessionKey.split(':');
  return agentId || 'main';
}

function buildFallbackMainSessionKey(agentId: string): string {
  return `agent:${normalizeAgentId(agentId)}:main`;
}

function toThinkingLevel(mode: ReasoningMode): 'off' | 'medium' {
  return mode === 'fast' ? 'off' : 'medium';
}

function isSlashCommand(message: string): boolean {
  return message.trimStart().startsWith('/');
}

function normalizeLightweightInput(message: string): string {
  return message
    .trim()
    .toLowerCase()
    .replace(/[\s，。！？!?,.～~、；;：:]+/g, '');
}

function isLightweightInput(message: string, hasMedia: boolean): boolean {
  if (hasMedia || isSlashCommand(message)) return false;
  const normalized = normalizeLightweightInput(message);
  if (!normalized) return false;
  const lightweightPhrases = new Set([
    'hello',
    'hi',
    'hey',
    '你好',
    '您好',
    '在吗',
    '在嘛',
    '哈喽',
    '嗨',
    '谢谢',
    'thanks',
    'thankyou',
    'ok',
    '好的',
    '好',
    '嗯',
  ]);
  return lightweightPhrases.has(normalized);
}

function getEffectiveReasoningMode(message: string, selectedMode: ReasoningMode, hasMedia: boolean): ReasoningMode {
  if (isLightweightInput(message, hasMedia)) return 'fast';
  return selectedMode;
}

// Mimo model detection and directive
function isMimoModel(): boolean {
  const agentsState = useAgentsStore.getState();
  const mainAgent = agentsState.agents.find((a) => a.id === 'main');
  const modelRef = mainAgent?.modelRef ?? mainAgent?.overrideModelRef ?? agentsState.defaultModelRef;
  return modelRef != null && modelRef.startsWith('ly-mimo/');
}

function withThinkingDirective(message: string, mode: ReasoningMode): string {
  if (isSlashCommand(message)) {
    return message;
  }
  const isMimo = isMimoModel();
  return `/think ${isMimo ? 'off' : toThinkingLevel(mode)} ${message}`;
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
  planningRunId: string | null;
};

const pendingComplexTaskPlans = new Map<string, PendingComplexTaskPlan>();

function looksLikeComplexBuildTask(message: string, attachmentCount: number): boolean {
  // Temporarily disabled: keep cleanup/compatibility code, but do not rewrite
  // new user prompts into staged internal control prompts.
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

export function buildComplexTaskExecutionRequest(originalMessage: string, planText: string): string {
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

export function getPendingComplexTaskPlan(sessionKey: string): PendingComplexTaskPlan | undefined {
  return pendingComplexTaskPlans.get(sessionKey);
}

export function clearPendingComplexTaskPlan(sessionKey: string): void {
  pendingComplexTaskPlans.delete(sessionKey);
}

function rememberPendingComplexTaskPlan(sessionKey: string, originalMessage: string): void {
  pendingComplexTaskPlans.set(sessionKey, {
    originalMessage,
    planningRunId: null,
  });
}

function markPendingComplexTaskPlanningRun(sessionKey: string, runId: string): void {
  const pendingPlan = pendingComplexTaskPlans.get(sessionKey);
  if (!pendingPlan) return;
  pendingComplexTaskPlans.set(sessionKey, {
    ...pendingPlan,
    planningRunId: runId,
  });
}

function abortGatewayRun(sessionKey: string): void {
  void invokeIpc(
    'gateway:rpc',
    'sessions.abort',
    { key: sessionKey },
    8_000,
  ).catch((error) => {
    console.warn('[chat] Failed to abort stuck run:', error);
  });
}

async function patchSessionThinkingLevel(sessionKey: string, mode: ReasoningMode): Promise<void> {
  const result = await invokeIpc(
    'gateway:rpc',
    'sessions.patch',
    {
      key: sessionKey,
      thinkingLevel: toThinkingLevel(mode),
    },
    5_000,
  ) as { success?: boolean; error?: string };

  if (result && result.success === false) {
    throw new Error(result.error || 'Failed to update thinking level');
  }
}

function applySessionThinkingLevelInBackground(
  _sessionKey: string,
  mode: ReasoningMode,
  set: ChatSet,
  get: ChatGet,
): { needsPatch: boolean } {
  const newLevel = toThinkingLevel(mode);
  const currentLevel = get().thinkingLevel;
  set({ thinkingLevel: newLevel });
  if (currentLevel === newLevel) {
    return { needsPatch: false };
  }
  return { needsPatch: true };
}

function deferSessionThinkingLevelPatch(
  sessionKey: string,
  mode: ReasoningMode,
): void {
  void patchSessionThinkingLevel(sessionKey, mode).catch((error) => {
    console.warn('[chat] Failed to persist thinking level; continuing with one-shot /think directive:', error);
  });
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

export function createRuntimeSendActions(set: ChatSet, get: ChatGet): Pick<RuntimeActions, 'sendMessage' | 'abortRun' | 'recoverCurrentSession'> {
  return {
    sendMessage: async (
      text: string,
      attachments?: Array<{ fileName: string; mimeType: string; fileSize: number; stagedPath: string; preview: string | null }>,
      targetAgentId?: string | null,
    ) => {
      const trimmed = text.trim();
      if (!trimmed && (!attachments || attachments.length === 0)) return;

      clearAbortedChatRuns();
      set({ emptyFinalRecovery: { status: 'idle' } });

      const targetSessionKey = resolveMainSessionKeyForAgent(targetAgentId) ?? get().currentSessionKey;
      if (targetSessionKey !== get().currentSessionKey) {
        const current = get();
        const leavingEmpty = !current.currentSessionKey.endsWith(':main') && current.messages.length === 0;
        set((s) => ({
          currentSessionKey: targetSessionKey,
          currentAgentId: getAgentIdFromSessionKey(targetSessionKey),
          sessions: ensureSessionEntry(
            leavingEmpty ? s.sessions.filter((session) => session.key !== current.currentSessionKey) : s.sessions,
            targetSessionKey,
          ),
          sessionLabels: leavingEmpty
            ? Object.fromEntries(Object.entries(s.sessionLabels).filter(([key]) => key !== current.currentSessionKey))
            : s.sessionLabels,
          sessionLastActivity: leavingEmpty
            ? Object.fromEntries(Object.entries(s.sessionLastActivity).filter(([key]) => key !== current.currentSessionKey))
            : s.sessionLastActivity,
          messages: [],
          streamingText: '',
          streamingMessage: null,
          streamingTools: [],
          activeRunId: null,
          activeTool: null,
          error: null,
          pendingFinal: false,
          lastUserMessageAt: null,
          pendingToolImages: [],
        }));
        await get().loadHistory(true);
      }

      const currentSessionKey = targetSessionKey;
      const reasoningMode = get().reasoningMode;
      applySessionThinkingLevelInBackground(currentSessionKey, reasoningMode, set, get);
      const attachmentCount = attachments?.length ?? 0;
      const originalRuntimeMessage = trimmed || (attachmentCount > 0 ? 'Process the attached file(s).' : '');
      const taskKind = detectTaskWorkflowKind(originalRuntimeMessage, attachments ?? []);
      const convergenceSystemPrompt = buildInitialConvergenceSystemPrompt(taskKind);
      const isInternalStagedExecution = trimmed.includes(COMPLEX_TASK_EXECUTION_MARKER);
      const usePlanningPhase = looksLikeComplexBuildTask(originalRuntimeMessage, attachmentCount);
      const runtimeMessage = usePlanningPhase
        ? buildComplexTaskPlanningRequest(originalRuntimeMessage)
        : withComplexTaskExecutionGuide(originalRuntimeMessage, attachmentCount);
      if (usePlanningPhase) {
        rememberPendingComplexTaskPlan(currentSessionKey, originalRuntimeMessage);
      } else {
        clearPendingComplexTaskPlan(currentSessionKey);
      }
      const hasMedia = Boolean(attachments && attachments.length > 0);
      const effectiveReasoningMode = getEffectiveReasoningMode(trimmed, reasoningMode, hasMedia);
      const { needsPatch } = applySessionThinkingLevelInBackground(currentSessionKey, reasoningMode, set, get);
      if (effectiveReasoningMode !== reasoningMode) {
        console.info('[chat.latency] using fast reasoning for lightweight input', {
          selectedReasoningMode: reasoningMode,
          effectiveReasoningMode,
          messageLength: trimmed.length,
          hasMedia,
        });
      }

      // Add user message optimistically (with local file metadata for UI display)
      const nowMs = Date.now();
      const userMsg: RawMessage = {
        role: 'user',
        content: trimmed || (attachments?.length ? '(file attached)' : ''),
        timestamp: nowMs / 1000,
        id: crypto.randomUUID(),
        _attachedFiles: attachments?.map(a => ({
          fileName: a.fileName,
          mimeType: a.mimeType,
          fileSize: a.fileSize,
          preview: a.preview,
          filePath: a.stagedPath,
          source: 'user-upload',
        })),
      };


      set((s) => ({
        messages: isInternalStagedExecution
          ? s.messages
          : dedupeEquivalentAttachmentUserMessages([...s.messages, userMsg]),
        sending: true,
        error: null,
        securityCancelNotice: null,
        streamingText: '',
        streamingMessage: null,
        streamingTools: [],
        activeTool: null,
        pendingFinal: false,
        lastUserMessageAt: nowMs,
      }));

      // Update session label with first user message text as soon as it's sent
      const { sessionLabels, messages } = get();
      const isFirstMessage = !messages.slice(0, -1).some((m) => m.role === 'user');
      if (!isInternalStagedExecution && !currentSessionKey.endsWith(':main') && isFirstMessage && !sessionLabels[currentSessionKey] && trimmed) {
        const truncated = trimmed.length > 50 ? `${trimmed.slice(0, 50)}…` : trimmed;
        set((s) => ({ sessionLabels: { ...s.sessionLabels, [currentSessionKey]: truncated } }));
      }

      // Mark this session as most recently active
      set((s) => ({
        sessionLastActivity: { ...s.sessionLastActivity, [currentSessionKey]: nowMs },
        sessions: s.sessions.map((session) => (
          session.key === currentSessionKey
            ? { ...session, lastMessageAt: nowMs }
            : session
        )),
      }));

      // Reset tracking for error recovery and safety timeout
      setLastChatEventAt(Date.now());
      clearHistoryPoll();
      clearErrorRecoveryTimer();
      const runawayToolObservation = createRunawayToolObservation({
        sessionKey: currentSessionKey,
        taskKind,
        initialStrategyInjected: Boolean(convergenceSystemPrompt),
        now: nowMs,
      });
      set((s) => ({
        runawayToolObservation,
        sessionRunawayToolObservations: {
          ...s.sessionRunawayToolObservations,
          [currentSessionKey]: runawayToolObservation,
        },
      }));

      const SOFT_NO_RESPONSE_NOTICE_MS = 90_000;
      const HARD_NO_RESPONSE_TIMEOUT_MS = 15 * 60_000;
      const PENDING_FINAL_STUCK_MS = 90_000;
      const TOOL_EXECUTION_STALE_MS = 2 * 60_000;
      let slowResponseNoticeLogged = false;
      const checkStuck = () => {
        void (async () => {
          const state = get();
          if (!state.sending) return;
          const idleMs = Date.now() - getLastChatEventAt();
          const hasRunningTools = state.streamingTools.some((tool) => tool.status === 'running');
          const backendSnapshot = await refreshSessionBackendActivity(currentSessionKey);
          if (backendSnapshot) {
            set({
              sessionBackendActivity: backendSnapshot.session,
              gatewayBackgroundActivity: backendSnapshot.background,
            });
          }
          const backendActivity = backendSnapshot?.session ?? get().sessionBackendActivity;
          const backendStillActive = backendActivity && !shouldForceAbortStuckRun(backendActivity);

          if (hasRunningTools && idleMs >= TOOL_EXECUTION_STALE_MS) {
            if (backendStillActive) {
              setTimeout(checkStuck, 10_000);
              return;
            }
            clearHistoryPoll();
            abortGatewayRun(currentSessionKey);
            clearPendingComplexTaskPlan(currentSessionKey);
            set({
              error: i18n.t('chat:errors.toolExecutionTimeout'),
              streamingText: '',
              streamingMessage: null,
              streamingTools: [],
              sending: false,
              activeRunId: null,
              pendingFinal: false,
              lastUserMessageAt: null,
            });
            return;
          }
          if (state.streamingMessage || state.streamingText) {
            setTimeout(checkStuck, 10_000);
            return;
          }
          if (state.pendingFinal) {
            if (idleMs >= PENDING_FINAL_STUCK_MS) {
              void get().loadHistory(true, { force: true }).finally(() => {
                const next = get();
                if (next.currentSessionKey !== currentSessionKey || !next.sending) return;
                if (Date.now() - getLastChatEventAt() < PENDING_FINAL_STUCK_MS / 2) return;
                if (next.sessionBackendActivity && !shouldForceAbortStuckRun(next.sessionBackendActivity)) return;
                clearHistoryPoll();
                clearErrorRecoveryTimer();
                set(buildClearedActiveRunPatch());
              });
            }
            setTimeout(checkStuck, 10_000);
            return;
          }
          if (idleMs < SOFT_NO_RESPONSE_NOTICE_MS) {
            setTimeout(checkStuck, 10_000);
            return;
          }
          if (idleMs < HARD_NO_RESPONSE_TIMEOUT_MS) {
            if (!slowResponseNoticeLogged) {
              slowResponseNoticeLogged = true;
              console.info('[chat.safety-timeout] still waiting for first model response', {
                idleMs,
                activeRunId: state.activeRunId,
                currentSessionKey,
              });
            }
            setTimeout(checkStuck, 15_000);
            return;
          }
          if (backendStillActive) {
            setTimeout(checkStuck, 10_000);
            return;
          }
          clearHistoryPoll();
          abortGatewayRun(currentSessionKey);
          clearPendingComplexTaskPlan(currentSessionKey);
          set({
            error: i18n.t('chat:errors.modelResponseTimeoutLong'),
            sending: false,
            activeRunId: null,
            lastUserMessageAt: null,
          });
        })();
      };
      setTimeout(checkStuck, 30_000);

      const idempotencyKey = crypto.randomUUID();
      try {
        if (hasMedia) {
          console.log('[sendMessage] Media paths:', attachments!.map(a => a.stagedPath));
        }

        // Cache image attachments BEFORE the IPC call to avoid race condition:
        // history may reload (via Gateway event) before the RPC returns.
        // Keyed by staged file path which appears in [media attached: <path> ...].
        if (hasMedia && attachments) {
          for (const a of attachments) {
            upsertImageCacheEntry(a.stagedPath, {
              fileName: a.fileName,
              mimeType: a.mimeType,
              fileSize: a.fileSize,
              preview: a.preview,
            });
          }
        }

        let result: { success: boolean; result?: { runId?: string }; error?: string };
        // Longer timeout for chat sends to tolerate high-latency networks (avoids connect error)
        const CHAT_SEND_TIMEOUT_MS = 120_000;

        if (hasMedia) {
          result = await invokeIpc(
            'chat:sendWithMedia',
            {
              sessionKey: currentSessionKey,
              message: withThinkingDirective(runtimeMessage, effectiveReasoningMode),
              deliver: false,
              idempotencyKey,
              extraSystemPrompt: convergenceSystemPrompt ?? undefined,
              media: attachments!.map((a) => ({
                filePath: a.stagedPath,
                mimeType: a.mimeType,
                fileName: a.fileName,
              })),
            },
          ) as { success: boolean; result?: { runId?: string }; error?: string };
        } else {
          const sessionId = currentSessionKey.startsWith('agent:')
            ? currentSessionKey.split(':').slice(2).join(':') || undefined
            : undefined;
          result = await invokeIpc(
            'gateway:rpc',
            'chat.send',
            {
              sessionKey: currentSessionKey,
              sessionId,
              message: withThinkingDirective(runtimeMessage, effectiveReasoningMode),
              deliver: false,
              idempotencyKey,
              extraSystemPrompt: convergenceSystemPrompt ?? undefined,
            },
            CHAT_SEND_TIMEOUT_MS,
          ) as { success: boolean; result?: { runId?: string }; error?: string };
        }

        console.log(`[sendMessage] RPC result: success=${result.success}, runId=${result.result?.runId || 'none'}`);

        // Defer sessions.patch until after chat.send completes to avoid competing for Gateway resources
        if (needsPatch) {
          deferSessionThinkingLevelPatch(currentSessionKey, reasoningMode);
        }

        if (!result.success) {
          clearHistoryPoll();
          const errorMessage = result.error || 'Failed to send message';
          if (isUserSecurityDenialMessage(errorMessage)) {
            set({
              error: null,
              runError: null,
              securityCancelNotice: buildSecurityCancelNotice(errorMessage),
              sending: false,
              activeRunId: null,
              streamingText: '',
              streamingMessage: null,
              streamingTools: [],
              pendingFinal: false,
              pendingToolImages: [],
              lastUserMessageAt: null,
            });
          } else {
            set({ error: errorMessage, sending: false });
          }
        } else if (result.result?.runId) {
          const runId = result.result.runId;
          markPendingComplexTaskPlanningRun(currentSessionKey, runId);
          const boundObservation = bindRunIdToObservation(
            get().sessionRunawayToolObservations[currentSessionKey] ?? get().runawayToolObservation,
            runId,
          );
          set((s) => ({
            activeRunId: runId,
            runawayToolObservation: boundObservation,
            sessionStreamingStates: {
              ...s.sessionStreamingStates,
              [currentSessionKey]: {
                ...(s.sessionStreamingStates[currentSessionKey] ?? {
                  activeRunId: null,
                  activeTool: null,
                  streamingText: '',
                  streamingMessage: null,
                  streamingTools: [],
                  pendingFinal: false,
                  lastUserMessageAt: null,
                  pendingToolImages: [],
                  runAborted: false,
                  sending: false,
                  messagesSnapshot: [],
                }),
                activeRunId: runId,
                sending: true,
                runAborted: false,
                messagesSnapshot: s.messages.length > 0
                  ? [...s.messages]
                  : (s.sessionStreamingStates[currentSessionKey]?.messagesSnapshot ?? []),
              },
            },
            sessionRunawayToolObservations: {
              ...s.sessionRunawayToolObservations,
              [currentSessionKey]: boundObservation,
            },
          }));
        }
      } catch (err) {
        clearHistoryPoll();
        const errorMessage = String(err);
        if (isUserSecurityDenialMessage(errorMessage)) {
          set({
            error: null,
            runError: null,
            securityCancelNotice: buildSecurityCancelNotice(errorMessage),
            sending: false,
            activeRunId: null,
            activeTool: null,
            streamingText: '',
            streamingMessage: null,
            streamingTools: [],
            pendingFinal: false,
            pendingToolImages: [],
            lastUserMessageAt: null,
          });
        } else {
          set({ error: errorMessage, sending: false });
        }
      }
    },

    // ── Abort active run ──

    abortRun: async () => {
      clearHistoryPoll();
      clearErrorRecoveryTimer();
      markAbortHistoryQuietPeriod();
      markUserAbort();
      const { currentSessionKey, activeRunId, messages } = get();
      if (activeRunId) {
        markAbortedChatRun(activeRunId);
      }
      clearToolWatchdogsForRun(set, get, activeRunId, 'user-cancelled');
      if (currentSessionKey) {
        persistUserAbortedSession(currentSessionKey, activeRunId);
      }

      set({
        sending: false,
        aborting: false,
        activeRunId: null,
        activeTool: null,
        streamingText: '',
        streamingMessage: null,
        pendingFinal: false,
        lastUserMessageAt: null,
        pendingToolImages: [],
        streamingTools: [],
        error: null,
        runAborted: true,
      });

      if (currentSessionKey) {
        const rpc = async (method: string, params: Record<string, unknown>, timeoutMs?: number) =>
          invokeIpc('gateway:rpc', method, params, timeoutMs);
        void Promise.allSettled([
          rpc(
            'sessions.abort',
            {
              key: currentSessionKey,
              ...(activeRunId ? { runId: activeRunId } : {}),
            },
            10_000,
          ),
          abortPendingChildDelegations(messages, rpc),
        ]).catch((err) => {
          console.warn('[abortRun] Failed to abort run:', err);
        });
      }
    },

    // ── Handle incoming chat events from Gateway ──
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
            runError: null,
            error: null,
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
  };
}
