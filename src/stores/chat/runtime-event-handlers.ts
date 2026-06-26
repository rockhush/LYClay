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
  isInternalMessageText,
  isUserSecurityDenialMessage,
  buildSecurityCancelNotice,
  isSuppressedRunError,
  isRecoverableRuntimeError,
  resolveRunFailureErrorMessage,
  shouldTreatAbortAsUserStop,
  truncateRunErrorMessage,
  makeAttachedFile,
  attachmentFileNameFromPath,
  normalizeStreamingMessage,
  setErrorRecoveryTimer,
  snapshotStreamingAssistantMessage,
  upsertToolStatuses,
} from './helpers';
import { buildClearedActiveRunPatch, shouldKeepRunActiveAfterAssistantFinal } from './run-lifecycle';
import { extractInvokedSkillIds } from './usage-report-extract';
import { reportSkillInvoke } from '@/lib/usage-reporter';

import type { AttachedFileMeta, RawMessage } from './types';
import { getEmptyFinalDiagnostic } from '@/lib/host-api';
import type { ChatGet, ChatSet } from './store-api';
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

function isStillConfirmingEmptyFinal(get: ChatGet, sessionKey: string, runId: string): boolean {
  const state = get();
  return state.currentSessionKey === sessionKey
    && (!runId || !state.activeRunId || state.activeRunId === runId);
}

function hasActiveRunningTool(get: ChatGet, sessionKey: string, runId: string): boolean {
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

function completeEmptyFinalFromHistory(set: ChatSet, get: ChatGet, sessionKey: string, runId: string): void {
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

async function confirmEmptyFinalWithHistory(set: ChatSet, get: ChatGet, runId: string): Promise<void> {
  const sessionKey = get().currentSessionKey;
  const beforeMessages = [...get().messages];

  set({
    streamingText: '',
    streamingMessage: null,
    pendingFinal: true,
    runError: null,
  });

  await get().loadHistory(true);
  if (isStillConfirmingEmptyFinal(get, sessionKey, runId) && hasNewAssistantOutput(beforeMessages, get().messages)) {
    completeEmptyFinalFromHistory(set, get, sessionKey, runId);
    return;
  }

  await waitForEmptyFinalRetry();
  if (!isStillConfirmingEmptyFinal(get, sessionKey, runId)) return;

  await get().loadHistory(true);
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
              if (isSuppressedRunError(messageError)) {
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
              if (isSuppressedRunError(messageError)) {
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
            const finalMsgContent = getMessageText(normalizedFinalMessage.content);
            if (finalMsgContent.trim() && isInternalMessageText(finalMsgContent)) {
              set({
                ...buildClearedActiveRunPatch(),
                runError: null,
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
            const keepRunActiveAfterFinal = shouldKeepRunActiveAfterAssistantFinal(normalizedFinalMessage)
              && !isExecApprovalFollowupRun(runId);
            const msgId = normalizedFinalMessage.id || (keepRunActiveAfterFinal ? `run-${runId}-tool-${Date.now()}` : `run-${runId}`);
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
            if (!keepRunActiveAfterFinal) {
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

          if (isForegroundEvent) {
            set((s) => {
              const currentStream = s.streamingMessage as RawMessage | null;
              const snapshotMsgs = snapshotStreamingAssistantMessage(currentStream, s.messages, runId);
              return {
                messages: timeoutMessage
                  ? [...s.messages, ...snapshotMsgs, timeoutMessage]
                  : [...s.messages, ...snapshotMsgs],
                streamingText: summary,
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
              streamingText: summary,
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

          set({
            error: displayError,
            runError: displayError,
            streamingText: '',
            streamingMessage: null,
            streamingTools: [],
            pendingFinal: false,
            pendingToolImages: [],
            ...(isRecoverableRuntimeError(errorMsg) ? {} : {
              sending: false,
              activeRunId: null,
              lastUserMessageAt: null,
              runAborted: isAbortErrorMessage(rawError),
            }),
          });

          if (wasSending && isRecoverableRuntimeError(errorMsg)) {
            clearErrorRecoveryTimer();
            const ERROR_RECOVERY_GRACE_MS = 5_000;
            setErrorRecoveryTimer(setTimeout(() => {
              setErrorRecoveryTimer(null);
              const state = get();
              if (state.sending && !state.streamingMessage) {
                clearHistoryPoll();
                set({
                  sending: false,
                  activeRunId: null,
                  activeTool: null,
                  lastUserMessageAt: null,
                });
                state.loadHistory(true);
              }
            }, ERROR_RECOVERY_GRACE_MS));
          } else if (wasSending) {
            clearHistoryPoll();
            void get().loadHistory(true, { force: true });
          } else {
            clearHistoryPoll();
            set({ sending: false, activeRunId: null, lastUserMessageAt: null });
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
