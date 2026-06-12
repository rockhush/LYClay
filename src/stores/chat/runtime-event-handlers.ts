import {
  clearErrorRecoveryTimer,
  clearHistoryPoll,
  collectToolUpdates,
  extractImagesAsAttachedFiles,
  extractMediaRefs,
  extractRawFilePaths,
  getMessageText,
  getToolCallFilePath,
  hasErrorRecoveryTimer,
  hasNonToolAssistantContent,
  isToolOnlyMessage,
  isToolResultRole,
  isInternalMessageText,
  makeAttachedFile,
  attachmentFileNameFromPath,
  normalizeStreamingMessage,
  setErrorRecoveryTimer,
  snapshotStreamingAssistantMessage,
  upsertToolStatuses,
} from './helpers';
import { finishFirstSessionPerf, markFirstSessionRuntimeEvent } from './first-session-perf';
import { extractInvokedSkillIds } from './usage-report-extract';
import { reportSkillInvoke } from '@/lib/usage-reporter';
import type { AttachedFileMeta, RawMessage } from './types';
import type { ChatGet, ChatSet } from './store-api';
import { markChatRunRuntimeEvent } from './chat-run-perf';
// De-dup guard for the management/claw/report uploader. We may receive the
// same `final` event twice during recovery (gateway resend, reconnect race);
// without this guard a single tool_use turn could double-count skill
// invocations in the persistent queue.
//
// Note: token-consume is intentionally NOT reported from the renderer.
// The streaming `final` event payload doesn't reliably carry `usage`, so the
// uploader scans OpenClaw session transcripts (the same source that powers
// the dashboard's Token Usage History) at flush time instead.
const reportedToolCallIds = new Set<string>();
const REPORTED_DEDUPE_LIMIT = 1024;
function isTerminalAssistantErrorMessage(message: RawMessage | undefined): boolean {
  if (!message || message.role !== 'assistant') return false;
  const msg = message as RawMessage & { stopReason?: unknown; stop_reason?: unknown };
  return (msg.stopReason ?? msg.stop_reason) === 'error';
}

function getMessageErrorMessage(message: RawMessage | undefined): string {
  const msg = message as (RawMessage & { errorMessage?: unknown; error_message?: unknown }) | undefined;
  const value = msg?.errorMessage ?? msg?.error_message;
  return typeof value === 'string' && value.trim() ? value : 'An error occurred';
}
function noteReported(set: Set<string>, key: string): boolean {
  if (set.has(key)) return false;
  set.add(key);
  if (set.size > REPORTED_DEDUPE_LIMIT) {
    // Trim the oldest entries via Set iteration order to keep memory bounded
    // across long sessions.
    const overflow = set.size - REPORTED_DEDUPE_LIMIT;
    let removed = 0;
    for (const v of set) {
      if (removed >= overflow) break;
      set.delete(v);
      removed += 1;
    }
  }
  return true;
}

function reportUsageFromFinalAssistant(message: RawMessage | undefined, runId: string): void {
  if (!message) return;
  const role = String(message.role || '').toLowerCase();
  if (role !== 'assistant') return;
  // Skill invoke — once per tool_use block id within a run. We dedup on
  // `${runId}::${toolCallId}` rather than messageId+toolCallId because the
  // same tool_use block may be observed twice: first on the streaming
  // assistant message captured at toolResult-final time, then again on the
  // final text-only assistant message (whose id differs). Using the run+tool
  // pair guarantees a single report per actual tool invocation.
  const invocations = extractInvokedSkillIds(message);
  if (invocations.length === 0) {
    // Diagnostic log: when an assistant message reaches us with no detected
    // tool calls, dump the structural keys so we can spot a third format we
    // haven't covered yet (e.g. some runtime emits `function_call` instead).
    const msgAny = message as unknown as Record<string, unknown>;
    const contentSummary = Array.isArray(msgAny.content)
      ? `array(len=${(msgAny.content as unknown[]).length}, types=[${(msgAny.content as Array<Record<string, unknown>>)
        .map((b) => String(b?.type ?? 'unknown')).join(',')}])`
      : typeof msgAny.content;
    // eslint-disable-next-line no-console -- intentional debug aid for skill-invoke wiring.
    console.debug('[UsageReport] no skill invocations in message', {
      role: msgAny.role,
      hasToolCalls: Array.isArray(msgAny.tool_calls) || Array.isArray(msgAny.toolCalls),
      content: contentSummary,
      keys: Object.keys(msgAny),
    });
    return;
  }
  for (const { skillId, toolCallId } of invocations) {
    const dedupeKey = `${runId}::${toolCallId}`;
    if (noteReported(reportedToolCallIds, dedupeKey)) {
      // eslint-disable-next-line no-console
      console.debug(`[UsageReport] queueing skill-invoke ${skillId} (toolCallId=${toolCallId})`);
      void reportSkillInvoke(skillId, 1);
    }
  }
}
import { forgetAbortedChatRun, isAbortedChatRun } from './helpers';
import {
  buildComplexTaskExecutionRequest,
  clearPendingComplexTaskPlan,
  getPendingComplexTaskPlan,
} from './runtime-send-actions';

export function handleRuntimeEventState(
  set: ChatSet,
  get: ChatGet,
  event: Record<string, unknown>,
  resolvedState: string,
  runId: string,
): void {
      markFirstSessionRuntimeEvent({
        state: resolvedState,
        runId,
        hasMessage: Boolean(event.message),
      });
      markChatRunRuntimeEvent({
        state: resolvedState,
        runId,
        hasMessage: Boolean(event.message),
      });
      if (runId && isAbortedChatRun(runId) && resolvedState !== 'aborted' && resolvedState !== 'final' && resolvedState !== 'error') {
        return;
      }

      const { currentSessionKey, sessionStreamingStates } = get();
      const evtSessionKey = event.sessionKey != null ? String(event.sessionKey) : null;
      const inferredSessionKey = (() => {
        if (evtSessionKey != null) return evtSessionKey;
        if (!runId) return null;
        if (runId === get().activeRunId) return currentSessionKey;
        for (const [sessionKey, state] of Object.entries(sessionStreamingStates)) {
          if (state.activeRunId === runId) return sessionKey;
        }
        return null;
      })();
      const targetSessionKey = inferredSessionKey ?? currentSessionKey;
      const isForegroundEvent = targetSessionKey === currentSessionKey;
      const getBackgroundSessionState = () => {
        const stored = get().sessionStreamingStates[targetSessionKey];
        return stored ?? {
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
      };
      const patchBackgroundSessionState = (patch: Record<string, unknown>) => {
        set((s) => ({
          sessionStreamingStates: {
            ...s.sessionStreamingStates,
            [targetSessionKey]: {
              ...(s.sessionStreamingStates[targetSessionKey] ?? getBackgroundSessionState()),
              ...patch,
            },
          },
        }));
      };

      if (!isForegroundEvent && evtSessionKey) {
        const backgroundState = getBackgroundSessionState();
        const shouldProcessBackgroundEvent = Boolean(
          runId && backgroundState.activeRunId === runId
          || resolvedState === 'started'
        );
        if (!shouldProcessBackgroundEvent) {
          return;
        }
      }

      const applyStreamingState = (patch: Record<string, unknown>) => {
        if (isForegroundEvent) {
          set(patch as any);
        } else {
          patchBackgroundSessionState(patch);
        }
      };

      switch (resolvedState) {
        case 'started': {
          // Run just started (e.g. from console); show loading immediately.
          if (runId) {
            if (isForegroundEvent) {
              const { sending: currentSending } = get();
              if (!currentSending) {
                set({ sending: true, activeRunId: runId, error: null });
              }
            } else {
              applyStreamingState({ sending: true, activeRunId: runId, runAborted: false });
            }
          }
          break;
        }
        case 'delta': {
          if (runId && isAbortedChatRun(runId)) break;
          // If we're receiving new deltas, the Gateway has recovered from any
          // prior error — cancel the error finalization timer and clear the
          // stale error banner so the user sees the live stream again.
          if (hasErrorRecoveryTimer()) {
            clearErrorRecoveryTimer();
            set({ error: null });
          }
          const updates = collectToolUpdates(event.message, resolvedState);
          const computeNewStreamingMessage = (currentStream: unknown | null) => {
            if (event.message && typeof event.message === 'object') {
              const msgRole = (event.message as RawMessage).role;
              if (isToolResultRole(msgRole)) return currentStream;
              const msgObj = event.message as RawMessage;
              if (currentStream && msgObj.content === undefined) {
                return currentStream;
              }
              const msgContent = getMessageText(msgObj.content);
              if (msgContent.trim() && isInternalMessageText(msgContent)) {
                return null;
              }
            }
            return normalizeStreamingMessage(event.message ?? currentStream);
          };
          if (isForegroundEvent) {
            set((s) => ({
              streamingMessage: computeNewStreamingMessage(s.streamingMessage),
              streamingTools: updates.length > 0 ? upsertToolStatuses(s.streamingTools, updates) : s.streamingTools,
            }));
          } else {
            const prev = getBackgroundSessionState();
            patchBackgroundSessionState({
              streamingMessage: computeNewStreamingMessage(prev.streamingMessage),
              streamingTools: updates.length > 0 ? upsertToolStatuses(prev.streamingTools, updates) : prev.streamingTools,
              sending: true,
              activeRunId: runId || prev.activeRunId,
            });
          }
          break;
        }
        case 'final': {
          clearErrorRecoveryTimer();
          if (get().error) set({ error: null });
          // Message complete - add to history and clear streaming
          const finalMsg = event.message as RawMessage | undefined;
          if (!isForegroundEvent) {
            const prev = getBackgroundSessionState();
            if (!finalMsg) {
              patchBackgroundSessionState({
                streamingText: '',
                streamingMessage: null,
                pendingFinal: true,
              });
              break;
            }

            const normalizedFinalMessage = normalizeStreamingMessage(finalMsg) as RawMessage;
            if (isTerminalAssistantErrorMessage(normalizedFinalMessage)) {
              patchBackgroundSessionState({
                streamingText: '',
                streamingMessage: null,
                sending: false,
                activeRunId: null,
                pendingFinal: false,
                runError: getMessageErrorMessage(normalizedFinalMessage),
              });
              clearHistoryPoll();
              break;
            }

            const finalMsgContent = getMessageText(normalizedFinalMessage.content);
            if (finalMsgContent.trim() && isInternalMessageText(finalMsgContent)) {
              patchBackgroundSessionState({
                streamingText: '',
                streamingMessage: prev.streamingMessage,
                sending: false,
                activeRunId: null,
                pendingFinal: false,
              });
              clearHistoryPoll();
              break;
            }

            const updates = collectToolUpdates(normalizedFinalMessage, resolvedState);
            const toolOnly = isToolOnlyMessage(normalizedFinalMessage);
            const hasOutput = hasNonToolAssistantContent(normalizedFinalMessage);
            const msgId = normalizedFinalMessage.id || (toolOnly ? `run-${runId}-tool-${Date.now()}` : `run-${runId}`);
            const pendingImgs = prev.pendingToolImages;
            const msgWithImages: RawMessage = pendingImgs.length > 0
              ? {
                ...normalizedFinalMessage,
                role: (normalizedFinalMessage.role || 'assistant') as RawMessage['role'],
                id: msgId,
                _attachedFiles: [...(normalizedFinalMessage._attachedFiles || []), ...pendingImgs],
              }
              : { ...normalizedFinalMessage, role: (normalizedFinalMessage.role || 'assistant') as RawMessage['role'], id: msgId };
            const nextTools = updates.length > 0 ? upsertToolStatuses(prev.streamingTools, updates) : prev.streamingTools;
            const streamingTools = hasOutput ? [] : nextTools;
            const nextSnapshot = [...(prev.messagesSnapshot ?? []), msgWithImages];

            patchBackgroundSessionState({
              messagesSnapshot: nextSnapshot,
              streamingText: '',
              streamingMessage: null,
              sending: hasOutput ? false : prev.sending,
              activeRunId: hasOutput ? null : prev.activeRunId,
              pendingFinal: hasOutput ? false : true,
              streamingTools,
              pendingToolImages: [],
            });
            break;
          }

          if (finalMsg) {
            const normalizedFinalMessage = normalizeStreamingMessage(finalMsg) as RawMessage;
            if (isTerminalAssistantErrorMessage(normalizedFinalMessage)) {
              set({
                streamingText: '',
                streamingMessage: null,
                sending: false,
                activeRunId: null,
                pendingFinal: false,
                error: null,
                runError: getMessageErrorMessage(normalizedFinalMessage),
              });
              clearHistoryPoll();
              break;
            }
            const finalMsgContent = getMessageText(normalizedFinalMessage.content);
            if (finalMsgContent.trim() && isInternalMessageText(finalMsgContent)) {
              // 如果已经有流式消息，保留它而不是清空
              // 这可以防止 NO_REPLY 消息覆盖已经显示的结果
              set((s) => ({
                streamingText: '',
                streamingMessage: s.streamingMessage,  // 保留现有的流式消息
                sending: false,
                activeRunId: null,
                pendingFinal: false,
                runError: null,
              }));
              // Reload history to surface intermediate tool-use turns (thinking +
              // tool blocks) from the Gateway's authoritative record, since
              // NO_REPLY itself carries no visible content.
              finishFirstSessionPerf('final', runId);
              clearHistoryPoll();
              void get().loadHistory(true);
              break;
            }
            const updates = collectToolUpdates(normalizedFinalMessage, resolvedState);
            if (isToolResultRole(normalizedFinalMessage.role)) {
              // Resolve file path from the streaming assistant message's matching tool call
              const currentStreamForPath = get().streamingMessage as RawMessage | null;
              const matchedPath = (currentStreamForPath && normalizedFinalMessage.toolCallId)
                ? getToolCallFilePath(currentStreamForPath, normalizedFinalMessage.toolCallId)
                : undefined;
              // The toolResult final event NEVER carries tool_use blocks itself —
              // those live on the streaming assistant message that triggered the
              // tool. Capturing skill invocations here (before the streaming
              // message is cleared by the set() below) is the only reliable
              // place; the final text-only assistant message arrives later
              // without tool_use blocks at all. Dedup by toolCallId protects
              // against multiple toolResults firing for the same turn.
              if (currentStreamForPath) {
                reportUsageFromFinalAssistant(currentStreamForPath, runId);
              }

              // Mirror enrichWithToolResultFiles: collect images + file refs for next assistant msg
              const toolFiles: AttachedFileMeta[] = extractImagesAsAttachedFiles(normalizedFinalMessage.content)
                .map((file) => (file.source ? file : { ...file, source: 'tool-result' }));
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
            const hasOutput = hasNonToolAssistantContent(normalizedFinalMessage);
            const msgId = normalizedFinalMessage.id || (toolOnly ? `run-${runId}-tool-${Date.now()}` : `run-${runId}`);
            set((s) => {
              const nextTools = updates.length > 0 ? upsertToolStatuses(s.streamingTools, updates) : s.streamingTools;
              const streamingTools = hasOutput ? [] : nextTools;

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
                return toolOnly ? {
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
              return toolOnly ? {
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
                sending: hasOutput ? false : s.sending,
                activeRunId: hasOutput ? null : s.activeRunId,
                pendingFinal: hasOutput ? false : true,
                streamingTools,
                runError: null,
                ...clearPendingImages,
              };
            });
            // Queue management/claw/report records for token consume + skill invoke
            // before the message is shipped off to history reload — we operate on
            // the normalized payload so usage / tool_use blocks are stable.
            reportUsageFromFinalAssistant(normalizedFinalMessage, runId);

            // After the final response, quietly reload history to surface all intermediate
            // tool-use turns (thinking + tool blocks) from the Gateway's authoritative record.
            if (hasOutput && !toolOnly) {
              finishFirstSessionPerf('final', runId);
              clearHistoryPoll();
              void get().loadHistory(true);
              const pendingPlan = getPendingComplexTaskPlan(get().currentSessionKey);
              const finalText = getMessageText(normalizedFinalMessage.content);
              const isPlanningRun = pendingPlan
                && (!pendingPlan.planningRunId || pendingPlan.planningRunId === runId);
              if (isPlanningRun && finalText.trim()) {
                const sessionKey = get().currentSessionKey;
                clearPendingComplexTaskPlan(sessionKey);
                const executionRequest = buildComplexTaskExecutionRequest(
                  pendingPlan.originalMessage,
                  finalText,
                );
                window.setTimeout(() => {
                  const state = get();
                  if (state.currentSessionKey !== sessionKey || state.sending) return;
                  void state.sendMessage(executionRequest);
                }, 250);
              }
            }
          } else {
            // No message in final event - reload history to get complete data
            set({ streamingText: '', streamingMessage: null, pendingFinal: true, runError: null });
            get().loadHistory();
          }
          break;
        }
        case 'error': {
          const errorMsg = String(event.errorMessage || 'An error occurred');

          // 仅当用户主动终止（点击停止按钮）时才静默处理 abort error，
          // 系统侧 abort（如上下文溢出、provider 中断）应正常展示错误
          const isAbortError = errorMsg.toLowerCase().includes('abort') || errorMsg === 'This operation was aborted';
          const isUserAbort = runId && isAbortedChatRun(runId);
          if (isAbortError && isUserAbort) {
            set({
              sending: false,
              activeRunId: null,
              streamingText: '',
              streamingMessage: null,
              streamingTools: [],
              pendingFinal: false,
              pendingToolImages: [],
              error: null,
            });
            forgetAbortedChatRun(runId!);
            break;
          }

          const wasSending = get().sending;

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
            setErrorRecoveryTimer(setTimeout(() => {
              setErrorRecoveryTimer(null);
              const state = get();
              if (state.sending && !state.streamingMessage) {
                clearHistoryPoll();
                finishFirstSessionPerf('error', runId);
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
            }, ERROR_RECOVERY_GRACE_MS));
          } else {
            clearHistoryPoll();
            finishFirstSessionPerf('error', runId);
            set({ sending: false, activeRunId: null, lastUserMessageAt: null });
          }
          break;
        }
        case 'aborted': {
          clearHistoryPoll();
          clearErrorRecoveryTimer();
          set({
            sending: false,
            aborting: false,
            activeRunId: null,
            streamingText: '',
            streamingMessage: null,
            streamingTools: [],
            pendingFinal: false,
            lastUserMessageAt: null,
            pendingToolImages: [],
          });
          break;
        }
        default: {
          // Unknown or empty state — if we're currently sending and receive an event
          // with a message, attempt to process it as streaming data. This handles
          // edge cases where the Gateway sends events without a state field.
          const { sending } = get();
          if (sending && event.message && typeof event.message === 'object') {
            console.warn(`[handleChatEvent] Unknown event state "${resolvedState}", treating message as streaming delta. Event keys:`, Object.keys(event));
            const updates = collectToolUpdates(event.message, 'delta');
            set((s) => ({
              streamingMessage: normalizeStreamingMessage(event.message ?? s.streamingMessage),
              streamingTools: updates.length > 0 ? upsertToolStatuses(s.streamingTools, updates) : s.streamingTools,
            }));
          }
          break;
        }
      }
}
