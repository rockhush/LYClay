import {
  clearErrorRecoveryTimer,
  clearHistoryPoll,
  collectToolUpdates,
  extractImagesAsAttachedFiles,
  extractMediaRefs,
  extractRawFilePaths,
  forgetAbortedChatRun,
  getMessageText,
  getToolCallFilePath,
  hasErrorRecoveryTimer,
  hasNonToolAssistantContent,
  hasVisibleAssistantContent,
  isAbortedChatRun,
  isAbortErrorMessage,
  isToolOnlyMessage,
  isToolResultRole,
  shouldSuppressAssistantStreamingText,
  isUserSecurityDenialMessage,
  buildSecurityCancelNotice,
  isSuppressedRunError,
  shouldSuppressPartialSuccessRunError,
  isRecoverableRuntimeError,
  isFatalRuntimeError,
  resolveRunFailureErrorMessage,
  shouldTreatAbortAsUserStop,
  truncateRunErrorMessage,
  makeAttachedFile,
  attachmentFileNameFromPath,
  normalizeStreamingMessage,
  snapshotStreamingAssistantMessage,
  upsertToolStatuses,
} from './helpers';
import {
  buildClearedActiveRunPatch,
  findLatestVisibleUserIndex,
  isCumulativeRunFinalText,
  shouldKeepRunActiveAfterAssistantFinal,
  shouldSilentlyFinalizeRunOnAssistantFinal,
} from './run-lifecycle';
import { hasInFlightSubagentSignals, isSubagentDelegationAnnounceRun, parseChildSessionKeyFromAnnounceRun } from '@/lib/subagent-delegation';
import { deferClearUserTurnForOpenDelegation, tryFinalizeUserTurnAfterAssistantFinal, trySyncClearAnnounceWrapUp } from './finalize-turn-bridge';
import { hasOpenDelegatedBackendWork } from './user-turn-lifecycle';
import { ensureSessionBackendPolling } from './session-backend-bridge';
import { extractInvokedSkillIds } from './usage-report-extract';
import { reportSkillInvoke } from '@/lib/usage-reporter';
import {
  summarizeAssistantMessage,
  summarizeStreamingTools,
  summarizeUiSignals,
  traceTurnTransition,
} from './turn-state-trace';

import type { AttachedFileMeta, RawMessage } from './types';
import type { ChatGet, ChatSet } from './store-api';
import { confirmEmptyFinalWithHistory } from './empty-final-recovery';
import {
  buildComplexTaskExecutionRequest,
  clearPendingComplexTaskPlan,
  getPendingComplexTaskPlan,
} from './runtime-send-actions';
import {
  clearToolWatchdogsForRun,
  getRunningToolSnapshotFromMessage,
  trackRunningTool,
} from './tool-lifecycle-watchdog';
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

function isExecApprovalFollowupRun(runId: string): boolean {
  return runId.startsWith('exec-approval-followup:');
}

export function handleRuntimeEventState(
  set: ChatSet,
  get: ChatGet,
  event: Record<string, unknown>,
  resolvedState: string,
  runId: string,
): void {
      if (runId && isAbortedChatRun(runId) && resolvedState !== 'aborted' && resolvedState !== 'final' && resolvedState !== 'error') {
        return;
      }

      // Record the child that triggered this announce wrap-up. Its completion is
      // encoded only in the run id (never written to the parent transcript), so
      // without this its execution-graph branch would stay stuck "running".
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

      if (
        resolvedState === 'started'
        || resolvedState === 'final'
        || resolvedState === 'error'
        || resolvedState === 'aborted'
        || resolvedState === 'tool_timeout'
      ) {
        traceTurnTransition('runtime-event', {
          state: resolvedState,
          runId: runId || null,
          sessionKey: targetSessionKey,
          isForeground: isForegroundEvent,
          ui: isForegroundEvent ? summarizeUiSignals(get()) : null,
          message: summarizeAssistantMessage(
            event.message && typeof event.message === 'object'
              ? (event.message as RawMessage)
              : null,
          ),
        });
      }

      switch (resolvedState) {
        case 'started': {
          // Run just started (e.g. from console); show loading immediately.
          if (runId) {
            if (isForegroundEvent) {
              const { sending: currentSending } = get();
              if (!currentSending) {
                set({ sending: true, activeRunId: runId, error: null });
                traceTurnTransition('runtime-run-started', {
                  runId,
                  sessionKey: targetSessionKey,
                });
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
          if (updates.length > 0) {
            traceTurnTransition('runtime-tool-update', {
              state: resolvedState,
              runId: runId || null,
              sessionKey: targetSessionKey,
              tools: summarizeStreamingTools(updates),
            });
          }
          const computeNewStreamingMessage = (currentStream: unknown | null) => {
            if (event.message && typeof event.message === 'object') {
              const msgRole = (event.message as RawMessage).role;
              if (isToolResultRole(msgRole)) return currentStream;
              const msgObj = event.message as RawMessage;
              if (currentStream && msgObj.content === undefined) {
                return currentStream;
              }
              const msgContent = getMessageText(msgObj.content);
              if (msgContent.trim() && shouldSuppressAssistantStreamingText(msgContent)) {
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
          if (get().runError) set({ runError: null });
          // Message complete - add to history and clear streaming
          const finalMsg = event.message as RawMessage | undefined;
          if (!isForegroundEvent) {
            const prev = getBackgroundSessionState();
            if (!finalMsg) {
              patchBackgroundSessionState({
                ...buildClearedActiveRunPatch(),
                runError: null,
              });
              clearHistoryPoll();
              void get().loadHistory(true, { force: true });
              break;
            }

            const normalizedFinalMessage = normalizeStreamingMessage(finalMsg) as RawMessage;
            if (isTerminalAssistantErrorMessage(normalizedFinalMessage)) {
              const messageError = getMessageErrorMessage(normalizedFinalMessage);
              if (isSuppressedRunError(messageError)
                || shouldSuppressPartialSuccessRunError(messageError, normalizedFinalMessage)) {
                patchBackgroundSessionState({
                  streamingText: '',
                  streamingMessage: null,
                  sending: false,
                  activeRunId: null,
                  pendingFinal: false,
                  runError: null,
                });
                clearHistoryPoll();
                break;
              }
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

            if (shouldSilentlyFinalizeRunOnAssistantFinal(normalizedFinalMessage)) {
              const bgMessages = prev.messagesSnapshot ?? [];
              if (hasOpenDelegatedBackendWork(
                bgMessages,
                get().gatewayBackgroundActivity,
                get().sessionBackendActivity,
              )) {
                patchBackgroundSessionState({
                  streamingText: '',
                  streamingMessage: null,
                  sending: true,
                  activeRunId: prev.activeRunId || runId || null,
                  pendingFinal: true,
                });
                clearHistoryPoll();
                break;
              }
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
            if (isToolResultRole(normalizedFinalMessage.role)) {
              const runningTool = getRunningToolSnapshotFromMessage(normalizedFinalMessage, {
                sessionKey: targetSessionKey,
                runId,
              });
              if (runningTool) {
                trackRunningTool(set, get, runningTool, false);
              } else {
                clearToolWatchdogsForRun(set, get, runId, 'completed');
              }
            }
            const toolOnly = isToolOnlyMessage(normalizedFinalMessage);
            const hasOutput = hasVisibleAssistantContent(normalizedFinalMessage);
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

            if (hasOutput && !toolOnly) {
              clearToolWatchdogsForRun(set, get, runId, 'completed');
            }
            patchBackgroundSessionState({
              messagesSnapshot: nextSnapshot,
              streamingText: '',
              streamingMessage: null,
              sending: true,
              activeRunId: prev.activeRunId || runId || null,
              pendingFinal: true,
              streamingTools,
              pendingToolImages: [],
            });
            break;
          }

          if (finalMsg) {
            const normalizedFinalMessage = normalizeStreamingMessage(finalMsg) as RawMessage;
            if (isTerminalAssistantErrorMessage(normalizedFinalMessage)) {
              clearToolWatchdogsForRun(set, get, runId, 'tool-error');
              const messageError = getMessageErrorMessage(normalizedFinalMessage);
              if (isUserSecurityDenialMessage(messageError)) {
                set({
                  streamingText: '',
                  streamingMessage: null,
                  sending: false,
                  activeRunId: null,
                  pendingFinal: false,
                  runError: null,
                  error: null,
                  securityCancelNotice: buildSecurityCancelNotice(messageError),
                  streamingTools: [],
                });
                clearHistoryPoll();
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
                clearHistoryPoll();
                void get().loadHistory(true);
                break;
              }
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
            if (shouldSilentlyFinalizeRunOnAssistantFinal(normalizedFinalMessage)) {
              if (!isSubagentDelegationAnnounceRun(runId)
                && deferClearUserTurnForOpenDelegation(get, set, {
                sessionKey: targetSessionKey,
                runId,
              })) {
                clearHistoryPoll();
                void get().loadHistory(true, { force: true });
                break;
              }
              if (isSubagentDelegationAnnounceRun(runId)) {
                trySyncClearAnnounceWrapUp(get, set, { sessionKey: targetSessionKey, runId });
              }
              void tryFinalizeUserTurnAfterAssistantFinal(get, set, {
                sessionKey: targetSessionKey,
                runId,
                terminalMessage: normalizedFinalMessage,
              });
              clearHistoryPoll();
              void get().loadHistory(true, { force: true });
              break;
            }
            const updates = collectToolUpdates(normalizedFinalMessage, resolvedState);
            if (isToolResultRole(normalizedFinalMessage.role)) {
              const runningTool = getRunningToolSnapshotFromMessage(normalizedFinalMessage, {
                sessionKey: targetSessionKey,
                runId,
              });
              if (runningTool) {
                trackRunningTool(set, get, runningTool, true);
              } else {
                clearToolWatchdogsForRun(set, get, runId, 'completed');
              }
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
            const hasOutput = hasNonToolAssistantContent(normalizedFinalMessage);
            const keepRunActiveAfterFinal = isSubagentDelegationAnnounceRun(runId)
              ? false
              : shouldKeepRunActiveAfterAssistantFinal(normalizedFinalMessage)
              && !isExecApprovalFollowupRun(runId);
            const msgId = normalizedFinalMessage.id || (keepRunActiveAfterFinal ? `run-${runId}-tool-${Date.now()}` : `run-${runId}`);
            const userIdx = findLatestVisibleUserIndex(get().messages);
            const turnMessages = userIdx >= 0 ? get().messages.slice(userIdx + 1) : get().messages;
            const skipCumulativeOptimisticFinal = !keepRunActiveAfterFinal
              && hasOutput
              && msgId === `run-${runId}`
              && isCumulativeRunFinalText(getMessageText(normalizedFinalMessage.content), turnMessages);
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
              const alreadyExists = s.messages.some(m => m.id === msgId);
              if (alreadyExists || skipCumulativeOptimisticFinal) {
                return keepRunActiveAfterFinal ? {
                  streamingText: '',
                  streamingMessage: null,
                  pendingFinal: true,
                  streamingTools,
                  ...clearPendingImages,
                } : {
                  streamingText: '',
                  streamingMessage: null,
                  sending: s.sending,
                  activeRunId: s.activeRunId,
                  pendingFinal: true,
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
                sending: s.sending,
                activeRunId: s.activeRunId,
                pendingFinal: true,
                streamingTools,
                runError: null,
                ...clearPendingImages,
              };
            });
            // Queue management/claw/report records for token consume + skill invoke
            // before the message is shipped off to history reload — we operate on
            // the normalized payload so usage / tool_use blocks are stable.
            reportUsageFromFinalAssistant(normalizedFinalMessage, runId);

            traceTurnTransition('runtime-assistant-final', {
              runId: runId || null,
              sessionKey: targetSessionKey,
              keepRunActiveAfterFinal,
              hasOutput,
              terminal: summarizeAssistantMessage(normalizedFinalMessage),
              tools: summarizeStreamingTools(updates),
            });

            // Gateway state=final is authoritative. Intermediate tool rounds still
            // defer clearing via backend-activity gates inside tryFinalize.
            if (isSubagentDelegationAnnounceRun(runId)) {
              trySyncClearAnnounceWrapUp(get, set, { sessionKey: targetSessionKey, runId });
            }
            void tryFinalizeUserTurnAfterAssistantFinal(get, set, {
              sessionKey: targetSessionKey,
              runId,
              terminalMessage: normalizedFinalMessage,
            });
            clearHistoryPoll();
            void get().loadHistory(true, { force: true });
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
          } else {
            // No message in final event - confirm against history/diagnostics before
            // deciding whether this is a clean completion or stale active run.
            set({ streamingText: '', streamingMessage: null, pendingFinal: true, runError: null });
            void confirmEmptyFinalWithHistory(set, get, runId);
          }
          break;
        }
        case 'tool_timeout': {
          clearErrorRecoveryTimer();
          const timeoutMessage = event.message
            ? normalizeStreamingMessage(event.message) as RawMessage
            : null;
          const updates = timeoutMessage ? collectToolUpdates(timeoutMessage, 'error') : [];
          clearToolWatchdogsForRun(set, get, runId, 'tool-error');
          const toolName = timeoutMessage?.toolName || 'tool';
          const details = (timeoutMessage as (RawMessage & { details?: Record<string, unknown> }) | null)?.details;
          const cleanupSucceeded = details?.cleanupSucceeded;
          const summary = cleanupSucceeded === false
            ? `${toolName} 调用超时，底层资源清理失败；已反馈给模型换一种方式处理。`
            : `${toolName} 调用超时；已反馈给模型换一种方式处理。`;
          console.warn(`[chat.tool_timeout] ${summary}`, { runId, toolName, cleanupSucceeded });

          if (isForegroundEvent) {
            set((s) => {
              const currentStream = s.streamingMessage as RawMessage | null;
              const snapshotMsgs = snapshotStreamingAssistantMessage(currentStream, s.messages, runId);
              return {
                messages: timeoutMessage
                  ? [...s.messages, ...snapshotMsgs, timeoutMessage]
                  : [...s.messages, ...snapshotMsgs],
                streamingText: '',
                streamingMessage: null,
                pendingFinal: true,
                runError: null,
                error: null,
                sending: true,
                activeRunId: null,
                activeTool: null,
                streamingTools: updates.length > 0
                  ? upsertToolStatuses(s.streamingTools, updates)
                  : s.streamingTools,
              };
            });
          } else {
            const prev = getBackgroundSessionState();
            const currentMessages = (prev.messagesSnapshot ?? []) as RawMessage[];
            const currentStream = prev.streamingMessage as RawMessage | null;
            const snapshotMsgs = snapshotStreamingAssistantMessage(currentStream, currentMessages, runId);
            const nextMessages = timeoutMessage
              ? [...currentMessages, ...snapshotMsgs, timeoutMessage]
              : [...currentMessages, ...snapshotMsgs];
            patchBackgroundSessionState({
              messagesSnapshot: nextMessages,
              streamingText: '',
              streamingMessage: null,
              pendingFinal: true,
              runError: null,
              sending: true,
              activeRunId: null,
              activeTool: null,
              streamingTools: updates.length > 0
                ? upsertToolStatuses(prev.streamingTools, updates)
                : prev.streamingTools,
            });
          }
          break;
        }
        case 'error': {
          const rawError = String(event.errorMessage || 'An error occurred');
          const errorMsg = truncateRunErrorMessage(rawError);

          // 仅当用户主动终止（点击停止按钮）时才静默处理 abort error，
          // 系统侧 abort（如上下文溢出、provider 中断）应正常展示错误
          const isUserAbort = shouldTreatAbortAsUserStop(rawError, {
            runId,
            runAborted: get().runAborted,
          });
          if (isUserAbort) {
            clearToolWatchdogsForRun(set, get, runId, 'user-cancelled');
            set({
              sending: false,
              activeRunId: null,
              activeTool: null,
              streamingText: '',
              streamingMessage: null,
              streamingTools: [],
              pendingFinal: false,
              pendingToolImages: [],
              error: null,
              runError: null,
            });
            if (runId) forgetAbortedChatRun(runId);
            break;
          }

          clearToolWatchdogsForRun(set, get, runId, 'tool-error');
          const displayError = resolveRunFailureErrorMessage(rawError);

          const wasSending = get().sending;
          if (isUserSecurityDenialMessage(errorMsg)) {
            clearErrorRecoveryTimer();
            clearHistoryPoll();
            set({
              error: null,
              runError: null,
              securityCancelNotice: buildSecurityCancelNotice(errorMsg),
              streamingText: '',
              streamingMessage: null,
              streamingTools: [],
              pendingFinal: false,
              pendingToolImages: [],
              sending: false,
              activeRunId: null,
              activeTool: null,
              lastUserMessageAt: null,
            });
            break;
          }

          if (isSuppressedRunError(errorMsg)) {
            clearErrorRecoveryTimer();
            clearHistoryPoll();
            set({
              sending: false,
              activeRunId: null,
              activeTool: null,
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

          // Gateway 发出 error 事件意味着其内部重试（指数退避 + 模型回退）已全部
          // 耗尽，不会再自动恢复。此时应终止 thinking 状态，避免 UI 卡在"思考中"。
          // loadHistory 会从后端拉取最新消息（如果 Gateway 在最后时刻 commit 了部分
          // 回复），用户至少能看到已完成的内容。
          if (isRecoverableRuntimeError(errorMsg)) {
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
              activeTool: null,
              lastUserMessageAt: null,
            });
            if (wasSending) {
              void get().loadHistory(true, { force: true });
            }
            break;
          }

          // 只有真正阻塞任务继续的致命错误才展示给用户，
          // 其他一切运行时错误只记日志，避免干扰用户体验。
          if (isFatalRuntimeError(rawError)) {
            const userIdx2 = findLatestVisibleUserIndex(get().messages);
            const hasReply = userIdx2 >= 0
              && get().messages.slice(userIdx2 + 1).some(
                (m) => m.role === 'assistant' && hasVisibleAssistantContent(m),
              );
            if (hasReply) {
              console.warn('[chat.error-suppressed] 任务已有回复，跳过致命错误展示', {
                error: rawError,
                runId,
              });
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
              break;
            }
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
              runAborted: isAbortErrorMessage(rawError),
            });
          } else {
            console.warn('[chat.error-suppressed] 非致命错误，跳过展示', {
              error: rawError,
              runId,
            });
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
          }
          break;
        }
        case 'aborted': {
          clearHistoryPoll();
          clearErrorRecoveryTimer();
          clearToolWatchdogsForRun(set, get, runId, 'run-aborted');
          const isUserAbort = Boolean(runId && isAbortedChatRun(runId));
          if (isUserAbort) {
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
              error: null,
              runError: null,
            });
            forgetAbortedChatRun(runId!);
            break;
          }

          const displayError = resolveRunFailureErrorMessage('This operation was aborted');
          set({
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
            error: displayError,
            runError: displayError,
            runAborted: true,
          });
          void get().loadHistory(true, { force: true });
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
