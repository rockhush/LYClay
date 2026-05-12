import i18n from '@/i18n';
import { invokeIpc } from '@/lib/api-client';
import { useAgentsStore } from '@/stores/agents';
import {
  beginFirstSessionPerf,
  markFirstSessionRpcCompleted,
  markFirstSessionRpcStarted,
} from './first-session-perf';
import {
  clearErrorRecoveryTimer,
  clearHistoryPoll,
  getLastChatEventAt,
  setHistoryPollTimer,
  setLastChatEventAt,
  upsertImageCacheEntry,
} from './helpers';
import type { ChatSession, RawMessage, ReasoningMode } from './types';
import type { ChatGet, ChatSet, RuntimeActions } from './store-api';

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

function toThinkingLevel(mode: ReasoningMode): 'off' | 'medium' | 'high' {
  if (mode === 'fast') return 'off';
  if (mode === 'expert') return 'high';
  return 'medium';
}

function withThinkingDirective(message: string, mode: ReasoningMode): string {
  if (message.trimStart().startsWith('/')) {
    return message;
  }
  return `/think ${toThinkingLevel(mode)} ${message}`;
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
  sessionKey: string,
  mode: ReasoningMode,
  set: ChatSet,
): void {
  set({ thinkingLevel: toThinkingLevel(mode) });
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

export function createRuntimeSendActions(set: ChatSet, get: ChatGet): Pick<RuntimeActions, 'sendMessage' | 'abortRun'> {
  return {
    sendMessage: async (
      text: string,
      attachments?: Array<{ fileName: string; mimeType: string; fileSize: number; stagedPath: string; preview: string | null }>,
      targetAgentId?: string | null,
    ) => {
      const trimmed = text.trim();
      if (!trimmed && (!attachments || attachments.length === 0)) return;

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
          error: null,
          pendingFinal: false,
          lastUserMessageAt: null,
          pendingToolImages: [],
        }));
        await get().loadHistory(true);
      }

      const currentSessionKey = targetSessionKey;
      const reasoningMode = get().reasoningMode;
      applySessionThinkingLevelInBackground(currentSessionKey, reasoningMode, set);

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
        messages: [...s.messages, userMsg],
        sending: true,
        error: null,
        streamingText: '',
        streamingMessage: null,
        streamingTools: [],
        pendingFinal: false,
        lastUserMessageAt: nowMs,
      }));

      // Update session label with first user message text as soon as it's sent
      const { sessionLabels, messages } = get();
      const isFirstMessage = !messages.slice(0, -1).some((m) => m.role === 'user');
      if (!currentSessionKey.endsWith(':main') && isFirstMessage && !sessionLabels[currentSessionKey] && trimmed) {
        const truncated = trimmed.length > 50 ? `${trimmed.slice(0, 50)}…` : trimmed;
        set((s) => ({ sessionLabels: { ...s.sessionLabels, [currentSessionKey]: truncated } }));
      }

      // Mark this session as most recently active
      set((s) => ({ sessionLastActivity: { ...s.sessionLastActivity, [currentSessionKey]: nowMs } }));

      // Reset tracking for error recovery and safety timeout
      setLastChatEventAt(Date.now());
      clearHistoryPoll();
      clearErrorRecoveryTimer();

      const SOFT_NO_RESPONSE_NOTICE_MS = 90_000;
      const HARD_NO_RESPONSE_TIMEOUT_MS = 240_000;
      let slowResponseNoticeLogged = false;
      const checkStuck = () => {
        const state = get();
        if (!state.sending) return;
        if (state.streamingMessage || state.streamingText) return;
        if (state.pendingFinal) {
          setTimeout(checkStuck, 10_000);
          return;
        }
        const idleMs = Date.now() - getLastChatEventAt();
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
        clearHistoryPoll();
        set({
          error: i18n.t('chat:errors.modelResponseTimeoutLong'),
          sending: false,
          activeRunId: null,
          lastUserMessageAt: null,
        });
      };
      setTimeout(checkStuck, 30_000);

      let firstSessionPerfActive = false;
      let firstSessionPerfMethod = 'chat.send';
      try {
        const idempotencyKey = crypto.randomUUID();
        const hasMedia = attachments && attachments.length > 0;
        firstSessionPerfMethod = hasMedia ? 'chat.sendWithMedia' : 'chat.send';
        if (hasMedia) {
          console.log('[sendMessage] Media paths:', attachments!.map(a => a.stagedPath));
        }
        firstSessionPerfActive = beginFirstSessionPerf({
          sessionKey: currentSessionKey,
          idempotencyKey,
          messageLength: trimmed.length,
          hasMedia: Boolean(hasMedia),
          attachmentCount: attachments?.length ?? 0,
        });

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
        if (firstSessionPerfActive) {
          markFirstSessionRpcStarted(firstSessionPerfMethod);
        }

        if (hasMedia) {
          result = await invokeIpc(
            'chat:sendWithMedia',
            {
              sessionKey: currentSessionKey,
              message: withThinkingDirective(trimmed || 'Process the attached file(s).', reasoningMode),
              deliver: false,
              idempotencyKey,
              media: attachments.map((a) => ({
                filePath: a.stagedPath,
                mimeType: a.mimeType,
                fileName: a.fileName,
              })),
            },
          ) as { success: boolean; result?: { runId?: string }; error?: string };
        } else {
          result = await invokeIpc(
            'gateway:rpc',
            'chat.send',
            {
              sessionKey: currentSessionKey,
              message: withThinkingDirective(trimmed, reasoningMode),
              deliver: false,
              idempotencyKey,
            },
            CHAT_SEND_TIMEOUT_MS,
          ) as { success: boolean; result?: { runId?: string }; error?: string };
        }

        if (firstSessionPerfActive) {
          markFirstSessionRpcCompleted({
            method: firstSessionPerfMethod,
            success: result.success,
            runId: result.result?.runId ?? null,
            error: result.error,
          });
        }

        console.log(`[sendMessage] RPC result: success=${result.success}, runId=${result.result?.runId || 'none'}`);

        if (!result.success) {
          clearHistoryPoll();
          set({ error: result.error || 'Failed to send message', sending: false });
        } else if (result.result?.runId) {
          set({ activeRunId: result.result.runId });
        }
      } catch (err) {
        if (firstSessionPerfActive) {
          markFirstSessionRpcCompleted({
            method: firstSessionPerfMethod,
            success: false,
            error: String(err),
          });
        }
        clearHistoryPoll();
        set({ error: String(err), sending: false });
      }
    },

    // ── Abort active run ──

    abortRun: async () => {
      clearHistoryPoll();
      clearErrorRecoveryTimer();
      const { currentSessionKey, activeRunId } = get();
      
      // 立即重置所有状态，确保UI立即响应
      set({ 
        sending: false, 
        aborting: false,
        activeRunId: null,
        streamingText: '', 
        streamingMessage: null, 
        pendingFinal: false, 
        lastUserMessageAt: null, 
        pendingToolImages: [],
        streamingTools: [],
        error: null,
      });

      // 异步发送 abort 请求给 Gateway（不等待响应，避免阻塞）
      if (currentSessionKey && activeRunId) {
        invokeIpc(
          'gateway:rpc',
          'chat.abort',
          { sessionKey: currentSessionKey },
        ).catch((err) => {
          // 忽略错误，因为我们已经重置了状态
          console.warn('[abortRun] Failed to abort run:', err);
        });
      }
    },

    // ── Handle incoming chat events from Gateway ──

  };
}
