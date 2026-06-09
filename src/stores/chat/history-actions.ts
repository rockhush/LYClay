import { invokeIpc } from '@/lib/api-client';
import { hostApiFetch } from '@/lib/host-api';
import { useGatewayStore } from '@/stores/gateway';
import {
  clearErrorRecoveryTimer,
  clearHistoryPoll,
  enrichWithCachedImages,
  enrichWithToolResultFiles,
  getLatestOptimisticUserMessage,
  getMessageText,
  stripGatewayUserMetadata,
  isInternalMessage,
  isToolResultRole,
  loadMissingPreviews,
  matchesOptimisticUserMessage,
  normalizeComplexTaskControlUserMessages,
  toMs,
} from './helpers';
import { buildCronSessionHistoryPath, isCronSessionKey } from './cron-session-utils';
import {
  CHAT_HISTORY_STARTUP_RETRY_DELAYS_MS,
  classifyHistoryStartupRetryError,
  getStartupHistoryTimeoutOverride,
  shouldRetryStartupHistoryLoad,
  sleep,
} from './history-startup-retry';
import type { RawMessage } from './types';
import type { ChatGet, ChatSet, SessionHistoryActions } from './store-api';
import { applyTimeDecayStrategy, calculateHistoryLimits, type TimeDecayStats } from './history-time-decay';

const foregroundHistoryLoadSeen = new Set<string>();

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

export function createHistoryActions(
  set: ChatSet,
  get: ChatGet,
): Pick<SessionHistoryActions, 'loadHistory'> {
  return {
    loadHistory: async (quiet = false) => {
      const { currentSessionKey } = get();
      const { sessionLastActivity } = get();
      const lastActivityMs = sessionLastActivity[currentSessionKey];
      const limits = calculateHistoryLimits(lastActivityMs);
      const isInitialForegroundLoad = !quiet && !foregroundHistoryLoadSeen.has(currentSessionKey);
      const historyTimeoutOverride = getStartupHistoryTimeoutOverride(isInitialForegroundLoad);
      if (!quiet) set({ loading: true, error: null });

      const isCurrentSession = () => get().currentSessionKey === currentSessionKey;
      const getPreviewMergeKey = (message: RawMessage): string => (
        `${message.id ?? ''}|${message.role}|${message.timestamp ?? ''}|${getMessageText(message.content)}`
      );
      const getRunErrorFromMessages = (messages: RawMessage[]): string | null => {
        const latestAssistantMessage = [...messages].reverse().find((msg) => msg.role === 'assistant');
        if (!latestAssistantMessage) return null;
        const stopReason = (latestAssistantMessage as any).stopReason ?? (latestAssistantMessage as any).stop_reason;
        if (stopReason !== 'error') return null;
        return (latestAssistantMessage as any).errorMessage ?? (latestAssistantMessage as any).error_message ?? null;
      };
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
          return {
            loading: false,
            error: !quiet && errorMessage ? errorMessage : state.error,
            ...(hasMessages ? {} : { messages: [] as RawMessage[] }),
          };
        });
      };

      const applyLoadedMessages = (rawMessages: RawMessage[], thinkingLevel: string | null) => {
        if (!isCurrentSession()) return false;
        // Before filtering: attach images/files from tool_result messages to the next assistant message
        const messagesWithToolImages = enrichWithToolResultFiles(rawMessages);
        const filteredMessages = messagesWithToolImages.filter((msg) => !isToolResultRole(msg.role) && !isInternalMessage(msg));
        // Restore file attachments for user/assistant messages (from cache + text patterns)
        const enrichedMessages = normalizeComplexTaskControlUserMessages(enrichWithCachedImages(filteredMessages));

        // Preserve the optimistic user message during an active send.
        // The Gateway may not include the user's message in chat.history
        // until the run completes, causing it to flash out of the UI.
        let finalMessages = enrichedMessages;
        const userMsgAt = get().lastUserMessageAt;
        if (get().sending && userMsgAt) {
          const userMsMs = toMs(userMsgAt);
          const optimistic = getLatestOptimisticUserMessage(get().messages, userMsMs);
          if (optimistic) {
            // 检查历史中是否已经有匹配的用户消息
            const hasMatchingUser = enrichedMessages.some((message) =>
              matchesOptimisticUserMessage(message, optimistic, userMsMs),
            );
            // 如果没有匹配的，才添加乐观消息
            if (!hasMatchingUser) {
              finalMessages = [...enrichedMessages, optimistic];
            }
          }
        }

        // 在设置消息前进行去重，防止相同内容的用户消息重复出现
        const seenContent = new Set<string>();
        const deduplicatedMessages = finalMessages.filter((msg) => {
          if (msg.role === 'user') {
            const content = msg.content;
            if (seenContent.has(content)) {
              return false;
            }
            seenContent.add(content);
          }
          return true;
        });

        const runError = getRunErrorFromMessages(deduplicatedMessages);
        set({ messages: deduplicatedMessages, thinkingLevel, loading: false, runError });

        const { pendingFinal, lastUserMessageAt, sending: isSendingNow } = get();
        if (isSendingNow && runError) {
          clearHistoryPoll();
          clearErrorRecoveryTimer();
          set({
            sending: false,
            activeRunId: null,
            pendingFinal: false,
            lastUserMessageAt: null,
          });
        }

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
            ...(discoveredActivity && !s.sessionLastActivity[currentSessionKey]
              ? { sessionLastActivity: { ...s.sessionLastActivity, [currentSessionKey]: discoveredActivity } }
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

        // If we're sending but haven't received streaming events, check
        // whether the loaded history reveals intermediate tool-call activity.
        // This surfaces progress via the pendingFinal → ActivityIndicator path.
        const userMsTs = lastUserMessageAt ? toMs(lastUserMessageAt) : 0;
        const isAfterUserMsg = (msg: RawMessage): boolean => {
          if (!userMsTs || !msg.timestamp) return true;
          return toMs(msg.timestamp) >= userMsTs;
        };

        // If we're sending but haven't received streaming events, check
        // whether the loaded history reveals assistant activity (tool calls,
        // narration, etc.).  Setting pendingFinal surfaces the execution
        // graph / activity indicator in the UI.
        //
        // Note: we intentionally do NOT set sending=false here.  Run
        // completion is exclusively signalled by the Gateway's phase
        // 'completed' event (handled in gateway.ts) or by receiving a
        // 'final' streaming event (handled in runtime-event-handlers.ts).
        // Attempting to infer completion from message history is fragile
        // and leads to premature sending=false during server-side tool
        // execution.
        if (isSendingNow && !pendingFinal) {
          const hasRecentAssistantActivity = [...filteredMessages].reverse().some((msg) => {
            if (msg.role !== 'assistant') return false;
            return isAfterUserMsg(msg);
          });
          if (hasRecentAssistantActivity) {
            set({ pendingFinal: true });
          }
        }
        return true;
      };

      try {
        const loadHistoryStartTime = Date.now();
        let result: { success: boolean; result?: Record<string, unknown>; error?: string } | null = null;
        let lastError: unknown = null;

        const { gatewayReady } = useGatewayStore.getState().status;
        console.log(`[History] gatewayReady = ${gatewayReady}, type = ${typeof gatewayReady}`);
        
        if (gatewayReady !== true) {
          console.log(`[History] Gateway not ready, trying local filesystem for ${currentSessionKey}`);
          try {
            const localStart = Date.now();
            const response = await hostApiFetch<{ success: boolean; messages?: RawMessage[]; error?: string }>(
              `/api/sessions/history-local?sessionKey=${encodeURIComponent(currentSessionKey)}`
            );
            console.log(`[PERF] Local history read took ${Date.now() - localStart}ms, success: ${response.success}, messages: ${response.messages?.length || 0}`);
            
            if (response.success && Array.isArray(response.messages)) {
              const rawMessages = response.messages;
              const thinkingLevel = null;
              console.log(`[History] ✅ Loaded ${rawMessages.length} messages from LOCAL filesystem`);

              const { messages: decayedMessages, stats } = applyTimeDecayStrategy(rawMessages, lastActivityMs);
              if (stats.finalCount < stats.originalCount) {
                console.log(`[history-time-decay] ${currentSessionKey} (local): ${stats.originalCount}→${stats.finalCount} messages, ~${stats.estimatedTokens} tokens (${stats.hoursAgo.toFixed(1)}h ago)`);
              }

              const applied = applyLoadedMessages(decayedMessages, thinkingLevel);
              if (applied && isInitialForegroundLoad) {
                foregroundHistoryLoadSeen.add(currentSessionKey);
              }
              console.log(`[PERF] chat.history load COMPLETE (LOCAL), total=${Date.now() - loadHistoryStartTime}ms, messages=${decayedMessages.length}`);
              return;
            } else {
              console.warn(`[History] Local read failed or returned no messages, response:`, response);
            }
          } catch (localError) {
            console.warn(`[History] Local filesystem read failed with exception:`, localError);
          }
        }
        
        console.log(`[History] Attempting Gateway RPC for ${currentSessionKey}`);

        for (let attempt = 0; attempt <= CHAT_HISTORY_STARTUP_RETRY_DELAYS_MS.length; attempt += 1) {
          if (!isCurrentSession()) {
            break;
          }

          try {
            result = await invokeIpc(
              'gateway:rpc',
              'chat.history',
              { sessionKey: currentSessionKey, limit: limits.messageLimit },
              ...(historyTimeoutOverride != null ? [historyTimeoutOverride] as const : []),
            ) as { success: boolean; result?: Record<string, unknown>; error?: string };

            if (result.success) {
              lastError = null;
              break;
            }

            lastError = new Error(result.error || 'Failed to load chat history');
          } catch (error) {
            lastError = error;
          }

          if (!isCurrentSession()) {
            break;
          }

          const errorKind = classifyHistoryStartupRetryError(lastError);
          const shouldRetry = result?.success !== true
            && isInitialForegroundLoad
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

        if (result?.success && result.result) {
          const data = result.result;
          let rawMessages = Array.isArray(data.messages) ? data.messages as RawMessage[] : [];
          const thinkingLevel = data.thinkingLevel ? String(data.thinkingLevel) : null;
          if (rawMessages.length === 0 && isCronSessionKey(currentSessionKey)) {
            rawMessages = await loadCronFallbackMessages(currentSessionKey, limits.messageLimit);
          }

          const { messages: decayedMessages, stats } = applyTimeDecayStrategy(rawMessages, lastActivityMs);
          if (stats.finalCount < stats.originalCount) {
            console.log(`[history-time-decay] ${currentSessionKey}: ${stats.originalCount}→${stats.finalCount} messages, ~${stats.estimatedTokens} tokens (${stats.hoursAgo.toFixed(1)}h ago, limit=${stats.appliedMessageLimit})`);
          }

          const applied = applyLoadedMessages(decayedMessages, thinkingLevel);
          if (applied && isInitialForegroundLoad) {
            foregroundHistoryLoadSeen.add(currentSessionKey);
          }
          return;
        }

        const errorKind = classifyHistoryStartupRetryError(lastError);
        if (isCurrentSession() && isInitialForegroundLoad && errorKind) {
          console.warn('[chat.history] startup retry exhausted', {
            sessionKey: currentSessionKey,
            gatewayState: useGatewayStore.getState().status.state,
            errorKind,
            error: String(lastError),
          });
        }

        const fallbackMessages = await loadCronFallbackMessages(currentSessionKey, limits.messageLimit);
        if (fallbackMessages.length > 0) {
          const applied = applyLoadedMessages(fallbackMessages, null);
          if (applied && isInitialForegroundLoad) {
            foregroundHistoryLoadSeen.add(currentSessionKey);
          }
        } else if (errorKind === 'gateway_startup') {
          // Suppress error UI for gateway startup -- the history will load
          // once the gateway finishes initializing (via sidebar refresh or
          // the next session switch).
          set({ loading: false });
        } else {
          applyLoadFailure(
            result?.error
            || (lastError instanceof Error ? lastError.message : String(lastError))
            || 'Failed to load chat history',
          );
        }
      } catch (err) {
        console.warn('Failed to load chat history:', err);
        const fallbackMessages = await loadCronFallbackMessages(currentSessionKey, limits.messageLimit);
        if (fallbackMessages.length > 0) {
          const applied = applyLoadedMessages(fallbackMessages, null);
          if (applied && isInitialForegroundLoad) {
            foregroundHistoryLoadSeen.add(currentSessionKey);
          }
        } else {
          applyLoadFailure(String(err));
        }
      }
    },
  };
}
