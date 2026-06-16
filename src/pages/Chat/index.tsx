/**
 * Chat Page
 * Native React implementation communicating with OpenClaw Gateway
 * via gateway:rpc IPC. Session selector, thinking toggle, and refresh
 * are in the toolbar; messages render with markdown + streaming.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, Info, Loader2, Sparkles } from 'lucide-react';
import chatDoubleIcon from '@/assets/chat-double.svg';
import { useChatStore, type RawMessage } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';
import { useProviderStore } from '@/stores/providers';
import { useAgentsStore } from '@/stores/agents';
import { useDingTalkAuthStore } from '@/stores/dingtalk-auth';
import { hostApiFetch } from '@/lib/host-api';
import { LoaderBadge } from '@/components/common/LoadingSpinner';
import { ChatMessage } from './ChatMessage';
import { ChatInput } from './ChatInput';
import { ExecutionGraphCard } from './ExecutionGraphCard';
import { ChatToolbar } from './ChatToolbar';
import { extractImages, extractText, extractThinking, extractToolUse, stripProcessMessagePrefix } from './message-utils';
import { deriveTaskSteps, findReplyMessageIndex, parseSubagentCompletionInfo, type TaskStep } from './task-visualization';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { isSuppressedRunError } from '@/stores/chat/helpers';
import { useStickToBottomInstant } from '@/hooks/use-stick-to-bottom-instant';
import { useMinLoading } from '@/hooks/use-min-loading';
import { estimateGatewayWarmupProgress } from '@/lib/gateway-warmup-progress';
import { getChatWaitingMode, isFirstResponsePreparing } from '@/lib/chat-first-response-preparing';
import { useSkillsStore } from '@/stores/skills';
import { toast } from 'sonner';
import { formatWelcomeDisplayName } from '@/lib/welcome-display-name';
import {
  WELCOME_QUICK_ACTIONS,
  buildQuickActionComposerText,
  findSkillForQuickAction,
} from './welcome-quick-actions';

type GraphStepCacheEntry = {
  steps: ReturnType<typeof deriveTaskSteps>;
  agentLabel: string;
  sessionLabel: string;
  segmentEnd: number;
  replyIndex: number | null;
  triggerIndex: number;
};

type UserRunCard = {
  triggerIndex: number;
  replyIndex: number | null;
  active: boolean;
  agentLabel: string;
  sessionLabel: string;
  segmentEnd: number;
  steps: TaskStep[];
  messageStepTexts: string[];
  streamingReplyText: string | null;
  /** Whether to filter out 'thinking' kind steps in the ExecutionGraphCard. */
  isMimo: boolean;
  /**
   * Whether the trailing "Thinking..." indicator should be hidden for this
   * card. True only when the run's live stream is currently rendered AS a
   * streaming step inside the graph (the step itself already signals
   * liveness, so the extra indicator would be redundant). False in all
   * other cases 鈥?including when the stream is promoted to a bubble
   * below the graph, or when there is no streaming content at all (the
   * gap between tool rounds), because the graph has no visible activity
   * of its own in those windows and the indicator is what tells the user
   * "work is still in progress".
   */
  suppressThinking: boolean;
};

type RuntimeActivity = {
  startedAt: number;
  lastUpdateAt: number;
  signature: string;
};

type ActiveDelegation = {
  label: string | null;
  childSessionKey: string | null;
  childSessionId: string | null;
  runId: string | null;
};

function getPrimaryMessageStepTexts(steps: TaskStep[]): string[] {
  return steps
    .filter((step) => step.kind === 'message' && step.parentId === 'agent-run' && !!step.detail)
    .map((step) => step.detail!);
}

function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  if (minutes < 60) return restSeconds === 0 ? `${minutes}m` : `${minutes}m ${restSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`;
}

// Non-actionable runtime errors (user abort, session lock races) are hidden
// from the chat error bar and run termination notice.
function shouldHideRunError(error: string | null | undefined): boolean {
  return isSuppressedRunError(error);
}

function describeRunTermination(error: string | null): { title: string; detail: string } | null {
  if (!error) return null;
  if (shouldHideRunError(error)) return null;
  const normalized = error.toLowerCase();
  if (normalized.includes('llm idle timeout')) {
    return {
      title: 'Run ended',
      detail: 'The model stopped returning output for a while, so this run was ended automatically.',
    };
  }
  if (normalized.includes('modelresponsetimeoutlong') || normalized.includes('model response timeout')) {
    return {
      title: 'Run timed out',
      detail: 'Waiting for the model follow-up timed out, so the run was closed and the generated content was kept.',
    };
  }
  if (normalized.includes('rpc timeout')) {
    return {
      title: 'Run ended',
      detail: 'Communication with the service timed out, so the current flow did not continue.',
    };
  }
  if (normalized.includes('list index out of range') || normalized.includes('tool call stream error')) {
    return {
      title: '执行失败',
      detail: '执行失败，请重试！',
    };
  }
  if (normalized.includes('context overflow')) {
    return {
      title: '上下文过长',
      detail: '会话消息过多导致超出模型上下文窗口限制。建议开始新会话，或手动 /reset（/new）以刷新上下文。',
    };
  }
  return {
    title: 'Run ended',
    detail: error,
  };
}

function isToolResultMessage(message: RawMessage | undefined): boolean {
  if (!message || typeof message.role !== 'string') return false;
  const normalized = message.role.toLowerCase();
  return normalized === 'toolresult' || normalized === 'tool_result';
}

function tryParseJsonObject(text: string | null | undefined): Record<string, unknown> | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

// Keep the last non-empty execution-graph snapshot per session/run outside
// React state so `loadHistory` refreshes can still fall back to the previous
// steps without tripping React's set-state-in-effect lint rule.
const graphStepCacheStore = new Map<string, Record<string, GraphStepCacheEntry>>();
const streamingTimestampStore = new Map<string, number>();
const EMPTY_GRAPH_STEP_CACHE: Record<string, GraphStepCacheEntry> = {};

export function Chat() {
  const { t } = useTranslation('chat');
  const gatewayStatus = useGatewayStore((s) => s.status);
  const isGatewayRunning = gatewayStatus.state === 'running';
  const warmupStatus = gatewayStatus.warmupStatus;

  const [editingText, setEditingText] = useState<string | null>(null);
  const prefilledInput = useChatStore((s) => s.prefilledInput);
  const setPrefilledInput = useChatStore((s) => s.setPrefilledInput);
  const messages = useChatStore((s) => s.messages);
  const currentSessionKey = useChatStore((s) => s.currentSessionKey);
  const currentAgentId = useChatStore((s) => s.currentAgentId);
  const sessionLabels = useChatStore((s) => s.sessionLabels);
  const sessionLastActivity = useChatStore((s) => s.sessionLastActivity);
  const loading = useChatStore((s) => s.loading);
  const sending = useChatStore((s) => s.sending);
  const error = useChatStore((s) => s.error);
  const securityCancelNotice = useChatStore((s) => s.securityCancelNotice);
  const streamingMessage = useChatStore((s) => s.streamingMessage);
  const streamingText = useChatStore((s) => s.streamingText);
  const streamingTools = useChatStore((s) => s.streamingTools);
  const pendingFinal = useChatStore((s) => s.pendingFinal);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const abortRun = useChatStore((s) => s.abortRun);
  const clearError = useChatStore((s) => s.clearError);
  const newSession = useChatStore((s) => s.newSession);
  const clearSecurityCancelNotice = useChatStore((s) => s.clearSecurityCancelNotice);
  const loadHistory = useChatStore((s) => s.loadHistory);
  const fetchAgents = useAgentsStore((s) => s.fetchAgents);
  const agents = useAgentsStore((s) => s.agents);
  const runAborted = useChatStore((s) => s.runAborted);
  const defaultAccountId = useProviderStore((s) => s.defaultAccountId);
  const isMimo = defaultAccountId === 'ly-mimo';
  const subagentCompletionInfos = useMemo(
    () => messages.map((message) => parseSubagentCompletionInfo(message)),
    [messages],
  );

  const cleanupEmptySession = useChatStore((s) => s.cleanupEmptySession);
  const [childTranscripts, setChildTranscripts] = useState<Record<string, RawMessage[]>>({});
  // Persistent per-run override for the Execution Graph's expanded/collapsed
  // state. Keyed by a stable run id (trigger message id, or a fallback of
  // `${sessionKey}:${triggerIdx}`) so user toggles survive the `loadHistory`
  // refresh that runs after every final event 鈥?otherwise the card would
  // remount and reset. `undefined` values mean "user hasn't toggled, let the
  // card pick a default from its own `active` prop."
  const [graphExpandedOverrides, setGraphExpandedOverrides] = useState<Record<string, boolean>>({});
  const graphStepCache: Record<string, GraphStepCacheEntry> = graphStepCacheStore.get(currentSessionKey) ?? EMPTY_GRAPH_STEP_CACHE;
  // Include empty-thread loads (session switch clears messages before chat.history returns).
  // Otherwise the Welcome screen flashes and looks 鈥渟tuck鈥?until messages arrive.
  const minLoading = useMinLoading(loading);
  const { contentRef, scrollRef } = useStickToBottomInstant(currentSessionKey);

  // Auto scroll to bottom during sending/streaming, and when new messages arrive.
  // Runtime deltas update `streamingMessage`; `streamingText` is only a legacy
  // fallback and usually remains empty. Listening only to `streamingText`
  // leaves the growing reply below the viewport until the final message is
  // committed to history, which makes a healthy stream look like one batch.
  useEffect(() => {
    const scrollElement = scrollRef.current;
    if (!scrollElement) return;

    // During sending or streaming, always scroll to bottom immediately
    // Use requestAnimationFrame to ensure DOM is updated before scrolling
    requestAnimationFrame(() => {
      if (sending || streamingText || streamingTools.length > 0) {
        scrollElement.scrollTop = scrollElement.scrollHeight;
        return;
      }

      // When not sending/streaming, only scroll if we're already near the bottom (within 100px)
      const isNearBottom = scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight < 100;
      if (isNearBottom) {
        scrollElement.scrollTop = scrollElement.scrollHeight;
      }
    });
  }, [sending, streamingMessage, streamingText, streamingTools.length, messages.length, scrollRef]);

  // Load data when gateway is running.
  // When the store already holds messages for this session (i.e. the user
  // is navigating *back* to Chat), use quiet mode so the existing messages
  // stay visible while fresh data loads in the background.  This avoids
  // an unnecessary messages 鈫?spinner 鈫?messages flicker.
  useEffect(() => {
    return () => {
      // If the user navigates away without sending any messages, remove the
      // empty session so it doesn't linger as a ghost entry in the sidebar.
      cleanupEmptySession();
    };
  }, [cleanupEmptySession]);

  useEffect(() => {
    void fetchAgents();
  }, [fetchAgents]);

  // Load history for an empty thread when the session key (or message count) changes.
  // Do not require `gatewayReady`: `loadHistory` prefers local JSONL when the Gateway
  // is not ready yet, so gating only on `isGatewayReady` left new sessions / sidebar
  // switches waiting on the overlay until RPC came online.
  // Include currentSessionKey so switching between two empty threads still retriggers
  // (messages.length stays 0 鈥?without this, the effect never runs and the main pane
  // can stay on the welcome screen while the sidebar selection changes).
  // Do not list `loading` in deps: when history is empty, loadHistory(false) finishes with
  // messages still [] and loading false 鈥?that would retrigger this effect forever and
  // spam `chat.history` / local history IPC (each completion toggles `loading`).
  useEffect(() => {
    if (messages.length === 0 && !loading) {
      const state = useChatStore.getState();
      const hasLocalSession = Boolean(
        state.sessionLabels[state.currentSessionKey]
        || state.sessionLastActivity[state.currentSessionKey],
      );
      if (hasLocalSession) {
        const snapshot = state.sessionStreamingStates[state.currentSessionKey]?.messagesSnapshot;
        if (snapshot && snapshot.length > 0) {
          useChatStore.setState({ messages: snapshot });
        } else {
          const label = state.sessionLabels[state.currentSessionKey];
          if (label) {
            const activity = state.sessionLastActivity[state.currentSessionKey] ?? Date.now();
            useChatStore.setState({
              messages: [{
                role: 'user',
                content: label.endsWith('…') ? label.slice(0, -1) : label,
                timestamp: activity / 1000,
                id: `local-${state.currentSessionKey}`,
              }],
            });
          }
        }
        return;
      }
      void loadHistory();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally omit `loading` to avoid empty-thread refetch loops
  }, [currentSessionKey, messages.length, loadHistory]);

  useEffect(() => {
    const completions = subagentCompletionInfos
      .filter((value): value is NonNullable<typeof value> => value != null);
    const missing = completions.filter((completion) => !childTranscripts[completion.sessionId]);
    if (missing.length === 0) return;

    let cancelled = false;
    void Promise.all(
      missing.map(async (completion) => {
        try {
          const result = await hostApiFetch<{ success: boolean; messages?: RawMessage[] }>(
            `/api/sessions/transcript?agentId=${encodeURIComponent(completion.agentId)}&sessionId=${encodeURIComponent(completion.sessionId)}`,
          );
          if (!result.success) {
            console.warn('Failed to load child transcript:', {
              agentId: completion.agentId,
              sessionId: completion.sessionId,
              result,
            });
            return null;
          }
          return { sessionId: completion.sessionId, messages: result.messages || [] };
        } catch (error) {
          console.warn('Failed to load child transcript:', {
            agentId: completion.agentId,
            sessionId: completion.sessionId,
            error,
          });
          return null;
        }
      }),
    ).then((results) => {
      if (cancelled) return;
      setChildTranscripts((current) => {
        const next = { ...current };
        for (const result of results) {
          if (!result) continue;
          next[result.sessionId] = result.messages;
        }
        return next;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [subagentCompletionInfos, childTranscripts]);

  const streamMsg = streamingMessage && typeof streamingMessage === 'object'
    ? streamingMessage as unknown as { role?: string; content?: unknown; timestamp?: number }
    : null;
  const streamTimestamp = typeof streamMsg?.timestamp === 'number' ? streamMsg.timestamp : 0;
  useEffect(() => {
    if (!sending) {
      streamingTimestampStore.delete(currentSessionKey);
      return;
    }
    if (!streamingTimestampStore.has(currentSessionKey)) {
      streamingTimestampStore.set(currentSessionKey, streamTimestamp || Date.now() / 1000);
    }
  }, [currentSessionKey, sending, streamTimestamp]);

  const streamingTimestamp = sending
    ? (streamingTimestampStore.get(currentSessionKey) ?? streamTimestamp)
    : 0;
  const streamText = streamMsg ? extractText(streamMsg) : (typeof streamingMessage === 'string' ? streamingMessage : '');
  const hasStreamText = streamText.trim().length > 0;
  // Whether the streaming chunk currently carries a `thinking` block. Used as
  // a liveness signal so the run stays "active" (and the ExecutionGraphCard
  // keeps showing its trailing "Thinking..." indicator) during the brief window
  // between a tool finishing and the next text/tool chunk arriving 鈥?that gap
  // is normally only filled by streamed thinking. NOT included in
  // `shouldRenderStreaming`: a thinking-only stream chunk should not produce
  // a chat bubble (thinking is rendered exclusively inside the ExecutionGraph).
  const streamThinking = streamMsg ? extractThinking(streamMsg) : null;
  const hasStreamThinking = !!streamThinking && streamThinking.trim().length > 0;
  const streamTools = useMemo(() => streamMsg ? extractToolUse(streamMsg) : [], [streamMsg]);
  const hasStreamTools = streamTools.length > 0;
  const streamImages = useMemo(() => streamMsg ? extractImages(streamMsg) : [], [streamMsg]);
  const hasStreamImages = streamImages.length > 0;
  const hasStreamToolStatus = streamingTools.length > 0;
  const hasRunningStreamToolStatus = streamingTools.some((tool) => tool.status === 'running');
  const shouldRenderStreaming = sending && (hasStreamText || hasStreamTools || hasStreamImages || hasStreamToolStatus);
  const hasAnyStreamContent = hasStreamText || hasStreamThinking || hasStreamTools || hasStreamImages || hasStreamToolStatus;
  const [runtimeActivity, setRuntimeActivity] = useState<RuntimeActivity | null>(null);
  const [activityClock, setActivityClock] = useState(0);

  const showFirstResponseProgress = false;

  const chatWaitingMode = getChatWaitingMode({
    gatewayStatus,
    sending,
    streamingMessage: streamingMessage as RawMessage | string | null,
    streamingText,
    streamingTools,
  });

  const isEmpty = messages.length === 0
    && !sending
    && !loading
    && !sessionLabels[currentSessionKey]
    && !sessionLastActivity[currentSessionKey];

  const {
    foldedNarrationIndices,
    userRunCards,
  } = useMemo(() => {
    // Build an index of the *next* real user message after each position.
    // Gateway history may contain `role: 'user'` messages that are actually
    // tool-result wrappers (Anthropic API format).  These must NOT split
    // the run into multiple segments 鈥?only genuine user-authored messages
    // should act as run boundaries.
    const isRealUserMessage = (msg: RawMessage): boolean => {
      if (msg.role !== 'user') return false;
      const content = msg.content;
      if (!Array.isArray(content)) return true;
      // If every block in the content is a tool_result, this is a Gateway
      // tool-result wrapper, not a real user message.
      const blocks = content as Array<{ type?: string }>;
      return blocks.length === 0 || !blocks.every((b) => b.type === 'tool_result');
    };

    const nextUserMessageIndexes = new Array<number>(messages.length).fill(-1);
    let nextUserMessageIndex = -1;
    for (let idx = messages.length - 1; idx >= 0; idx -= 1) {
      nextUserMessageIndexes[idx] = nextUserMessageIndex;
      if (isRealUserMessage(messages[idx]) && !subagentCompletionInfos[idx]) {
        nextUserMessageIndex = idx;
      }
    }

    // Indices of intermediate assistant process messages that are represented
    // in the ExecutionGraphCard (narration text and/or thinking). We suppress
    // them from the chat stream so they don't appear duplicated below the graph.
    const folded = new Set<number>();

    const cards: UserRunCard[] = messages.flatMap((message, idx) => {
      if (!isRealUserMessage(message) || subagentCompletionInfos[idx]) return [];

    const runKey = message.id
      ? `msg-${message.id}`
      : `${currentSessionKey}:trigger-${idx}`;
    const nextUserIndex = nextUserMessageIndexes[idx];
    const segmentEnd = nextUserIndex === -1 ? messages.length : nextUserIndex;
    const segmentMessages = messages.slice(idx + 1, segmentEnd);
    const completionInfos = subagentCompletionInfos
      .slice(idx + 1, segmentEnd)
      .filter((value): value is NonNullable<typeof value> => value != null);
    // A run is considered "open" (still active) when it's the last segment
    // AND at least one of:
    //  - sending/pendingFinal/streaming data (normal streaming path)
    //  - segment has tool calls but no pure-text final reply yet (server-side
    //    tool execution 鈥?Gateway fires phase "end" per tool round which
    //    briefly clears sending, but the run is still in progress)
    const hasToolActivity = segmentMessages.some((m) =>
      m.role === 'assistant' && extractToolUse(m).length > 0,
    );
    // Locate the last tool-use message so we only count text messages that
    // come AFTER all tool calls as "final reply".  Intermediate narration
    // messages (pure text, no tool_use) sit BEFORE tool calls and must not
    // be misread as the concluding reply 鈥?otherwise `runStillExecutingTools`
    // flips to false between tool rounds, collapsing the trailing
    // "Thinking..." indicator during the brief gap before the next stream chunk.
    let lastToolUseOffset = -1;
    for (let i = segmentMessages.length - 1; i >= 0; i -= 1) {
      const m = segmentMessages[i];
      if (m.role === 'assistant' && extractToolUse(m).length > 0) {
        lastToolUseOffset = i;
        break;
      }
    }
    const hasFinalReply = segmentMessages.some((m, i) => {
      if (i <= lastToolUseOffset) return false;
      if (m.role !== 'assistant') return false;
      if (extractText(m).trim().length === 0) return false;
      const content = m.content;
      if (!Array.isArray(content)) return true;
      return !(content as Array<{ type?: string }>).some(
        (b) => b.type === 'tool_use' || b.type === 'toolCall',
      );
    });
      const runStillExecutingTools = hasToolActivity && !hasFinalReply;
      const hasCompletedSubagentReturn = completionInfos.length > 0;
      const hasLiveRuntimeSignal = hasStreamText
        || hasStreamThinking
        || hasStreamTools
        || hasStreamImages
        || hasRunningStreamToolStatus;
      // Once the subagent completion event is present in history, an otherwise
      // quiet parent run should not keep the graph alive solely because stale
      // sending/pendingFinal state has not been cleared yet.
      const subagentReturnSettled = hasCompletedSubagentReturn && !hasLiveRuntimeSignal;
      const isLatestOpenRun = nextUserIndex === -1
        && !subagentReturnSettled
        && (sending || pendingFinal || hasAnyStreamContent || (runStillExecutingTools && !error));
    const replyIndexOffset = findReplyMessageIndex(segmentMessages, isLatestOpenRun);
    const replyIndex = replyIndexOffset === -1 ? null : idx + 1 + replyIndexOffset;

    const buildSteps = (omitLastStreamingMessageSegment: boolean): TaskStep[] => {
      let builtSteps = deriveTaskSteps({
        messages: segmentMessages,
        streamingMessage: isLatestOpenRun ? streamingMessage : null,
        streamingTools: isLatestOpenRun ? streamingTools : [],
        omitLastStreamingMessageSegment: isLatestOpenRun ? omitLastStreamingMessageSegment : false,
      });

      for (const completion of completionInfos) {
        const childMessages = childTranscripts[completion.sessionId];
        if (!childMessages || childMessages.length === 0) continue;
        const branchRootId = `subagent:${completion.sessionId}`;
        const childSteps = deriveTaskSteps({
          messages: childMessages,
          streamingMessage: null,
          streamingTools: [],
        }).map((step) => ({
          ...step,
          id: `${completion.sessionId}:${step.id}`,
          depth: step.depth + 1,
          parentId: branchRootId,
        }));

        builtSteps = [
          ...builtSteps,
          {
            id: branchRootId,
            label: `${completion.agentId} subagent`,
            status: 'completed',
            kind: 'system' as const,
            detail: completion.sessionKey,
            depth: 1,
            parentId: 'agent-run',
          },
          ...childSteps,
        ];
      }

      return builtSteps;
    };

    // Show a text-only stream as a normal assistant bubble while it arrives.
    // If a later delta adds a tool call, the stream is demoted into the
    // execution graph on the next render.
    //
    // We use an optimistic promotion strategy because the distinguishing
    // signal between "narration-before-next-tool" and "final reply" is not
    // available during early deltas 鈥?both are text-only, both arrive after
    // `hasToolActivity` has flipped true.  Any of these signals opens the
    // promotion gate:
    // This optimistic promotion also applies before the first tool call. That
    // is required for ordinary no-tool answers: otherwise their cumulative
    // deltas are classified as graph narration and the user sees the whole
    // answer only when the final event moves it into message history.
    //
    // Demotion happens the moment a tool_use block appears in the streaming
    // message (`streamTools.length > 0`). We deliberately do not gate this on
    // `streamingTools`: a completed tool can remain marked `running` briefly
    // while the next assistant turn is already streaming. Using that stale
    // status here hides both process narration and the final reply until the
    // terminal event arrives.
    //
    const rawStreamingReplyCandidate = isLatestOpenRun
      && (hasStreamText || hasStreamImages)
      && streamTools.length === 0;

    let steps = buildSteps(rawStreamingReplyCandidate);
    let streamingReplyText: string | null = null;
    if (rawStreamingReplyCandidate) {
      const trimmedReplyText = stripProcessMessagePrefix(streamText, getPrimaryMessageStepTexts(steps));
      const hasReplyText = trimmedReplyText.trim().length > 0;
      if (hasReplyText || hasStreamImages) {
        streamingReplyText = trimmedReplyText;
      } else {
        steps = buildSteps(false);
      }
    }

    const segmentAgentId = currentAgentId;
    const segmentAgentLabel = agents.find((agent) => agent.id === segmentAgentId)?.name || segmentAgentId;
    const segmentSessionLabel = sessionLabels[currentSessionKey] || currentSessionKey;

    if (steps.length === 0) {
      if (isLatestOpenRun && streamingReplyText == null) {
        return [{
          triggerIndex: idx,
          replyIndex,
          active: isLatestOpenRun && !runAborted,
          agentLabel: segmentAgentLabel,
          sessionLabel: segmentSessionLabel,
          segmentEnd: nextUserIndex === -1 ? messages.length - 1 : nextUserIndex - 1,
          steps: [],
          messageStepTexts: [],
          streamingReplyText: null,
          suppressThinking: false,
          isMimo,
        }];
      }
      const cached = graphStepCache[runKey];
      if (!cached) return [];
      // The cache was captured during streaming and may contain stream-
      // generated message steps that include accumulated narration + reply
      // text.  Strip these out 鈥?historical message steps (from messages[])
      // will be properly recomputed on the next render with fresh data.
      const cleanedSteps = cached.steps.filter(
        (s) => !(s.kind === 'message' && s.id.startsWith('stream-message')),
      );
      return [{
        triggerIndex: idx,
        replyIndex: cached.replyIndex,
        active: false,
        agentLabel: cached.agentLabel,
        sessionLabel: cached.sessionLabel,
        segmentEnd: nextUserIndex === -1 ? messages.length - 1 : nextUserIndex - 1,
        steps: cleanedSteps,
        messageStepTexts: getPrimaryMessageStepTexts(cleanedSteps),
        streamingReplyText: null,
        suppressThinking: false,
        isMimo,
      }];
    }

    // Mark intermediate assistant messages whose process output should be folded into
    // the ExecutionGraphCard. We fold the text regardless of whether the
    // message ALSO carries tool calls (mixed `text + toolCall` messages are
    // common 鈥?e.g. "waiting for the page to load鈥? followed by a `wait`
    // tool call). This prevents orphan narration bubbles from leaking into
    // the chat stream once the graph is collapsed.
    //
    // When the run is still streaming (`isLatestOpenRun`) the final reply is
    // not yet part of `segmentMessages`, so every assistant message in the
    // segment counts as intermediate. For completed runs, we preserve the
    // final reply bubble by skipping the message that `findReplyMessageIndex`
    // identifies as the answer.
    const segmentReplyOffset = findReplyMessageIndex(segmentMessages, isLatestOpenRun);
    for (let offset = 0; offset < segmentMessages.length; offset += 1) {
      if (offset === segmentReplyOffset) continue;
      const candidate = segmentMessages[offset];
      if (!candidate || candidate.role !== 'assistant') continue;
      const hasNarrationText = extractText(candidate).trim().length > 0;
      const hasThinking = !!extractThinking(candidate);
      if (!hasNarrationText && !hasThinking) continue;
      folded.add(idx + 1 + offset);
    }

    // The graph should stay "active" (expanded, can show trailing thinking)
    // for the entire duration of the run 鈥?not just until a streaming reply
    // appears.  Tying active to streamingReplyText caused a flicker: a brief
    // active鈫抐alse鈫抰rue transition collapsed the graph via ExecutionGraphCard's
    // uncontrolled path before the controlled `expanded` override could kick in.
    // When runAborted is true, card should not be active (user manually stopped)
    const cardActive = isLatestOpenRun && !runAborted;

    // Suppress the trailing "Thinking..." indicator only when the live stream is
    // currently rendered AS a streaming step inside this card's graph. In
    // that case the streaming step itself is the activity signal, and the
    // separate trailing indicator would be redundant.
    //   - streamingReplyText != null: stream is promoted to a bubble 鈫?graph
    //     has no live step of its own 鈫?DO show the trailing indicator so the
    //     user still sees progress in the graph (indicator rendered above the
    //     bubble).
    //   - no stream content at all (the gap between tool rounds): graph also
    //     has no live step 鈫?DO show the indicator 鈥?this is the very case
    //     the indicator exists for.
    //   - stream IS in graph (e.g. tool_use is streaming): indicator is
    //     redundant 鈫?suppress.
    const streamIsInGraph =
      isLatestOpenRun && streamingReplyText == null && hasAnyStreamContent;
    const suppressThinking = streamIsInGraph;

      return [{
        triggerIndex: idx,
        replyIndex,
        active: cardActive,
        agentLabel: segmentAgentLabel,
        sessionLabel: segmentSessionLabel,
        segmentEnd: nextUserIndex === -1 ? messages.length - 1 : nextUserIndex - 1,
        steps,
        messageStepTexts: getPrimaryMessageStepTexts(steps),
        streamingReplyText,
        suppressThinking,
        isMimo,
      }];
    });

    return {
      foldedNarrationIndices: folded,
      userRunCards: cards,
    };
  }, [
    agents,
    childTranscripts,
    currentAgentId,
    currentSessionKey,
    graphStepCache,
    hasAnyStreamContent,
    hasRunningStreamToolStatus,
    hasStreamImages,
    hasStreamText,
    hasStreamThinking,
    hasStreamTools,
    isMimo,
    messages,
    pendingFinal,
    runAborted,
    error,
    sending,
    sessionLabels,
    streamText,
    streamTools,
    streamingMessage,
    streamingTools,
    subagentCompletionInfos,
  ]);
  const hasActiveExecutionGraph = userRunCards.some((card) => card.active);
  const hasVisibleRuntimeActivity = sending || hasActiveExecutionGraph;
  const activeDelegation = useMemo<ActiveDelegation | null>(() => {
    const activeCard = [...userRunCards].reverse().find((card) => card.active);
    if (!activeCard) return null;

    const segmentMessages = messages.slice(activeCard.triggerIndex + 1, activeCard.segmentEnd + 1);
    const completionInfos = subagentCompletionInfos
      .slice(activeCard.triggerIndex + 1, activeCard.segmentEnd + 1)
      .filter((value): value is NonNullable<typeof value> => value != null);

    type SpawnCallInfo = {
      toolCallId: string | null;
      label: string | null;
    };

    const spawnCalls: SpawnCallInfo[] = [];
    for (const message of segmentMessages) {
      if (!message || message.role !== 'assistant') continue;
      for (const tool of extractToolUse(message)) {
        if (!/sessions_spawn/i.test(tool.name)) continue;
        const input = (tool.input && typeof tool.input === 'object') ? tool.input as Record<string, unknown> : null;
        spawnCalls.push({
          toolCallId: tool.id || null,
          label: typeof input?.label === 'string' ? input.label : null,
        });
      }
    }
    if (spawnCalls.length === 0) return null;

    const latestSpawn = spawnCalls[spawnCalls.length - 1]!;
    let childSessionKey: string | null = null;
    let runId: string | null = null;

    for (let idx = segmentMessages.length - 1; idx >= 0; idx -= 1) {
      const message = segmentMessages[idx];
      if (!isToolResultMessage(message)) continue;
      if (latestSpawn.toolCallId && message.toolCallId && message.toolCallId !== latestSpawn.toolCallId) continue;
      const parsed = tryParseJsonObject(extractText(message));
      if (!parsed) continue;
      if (typeof parsed.childSessionKey === 'string') {
        childSessionKey = parsed.childSessionKey;
      }
      if (typeof parsed.runId === 'string') {
        runId = parsed.runId;
      }
      if (childSessionKey || runId) break;
    }

    const completion = childSessionKey
      ? completionInfos.find((info) => info.sessionKey === childSessionKey) ?? null
      : completionInfos.at(-1) ?? null;

    if (completion) return null;

    return {
      label: latestSpawn.label,
      childSessionKey,
      childSessionId: null,
      runId,
    };
  }, [messages, subagentCompletionInfos, userRunCards]);
  const activitySignature = useMemo(() => JSON.stringify({
    sending,
    hasActiveExecutionGraph,
    pendingFinal,
    streamTextLength: streamText.length,
    hasStreamThinking,
    streamTools: streamTools.map((tool) => `${tool.name ?? tool.id ?? 'tool'}:${tool.id ?? ''}`),
    streamingTools: streamingTools.map((tool) => `${tool.name ?? tool.id ?? 'tool'}:${tool.status}:${tool.updatedAt ?? ''}`),
    messageCount: messages.length,
    activeRunCards: userRunCards.filter((card) => card.active).length,
    delegation: activeDelegation ? {
      label: activeDelegation.label,
      childSessionKey: activeDelegation.childSessionKey,
      runId: activeDelegation.runId,
    } : null,
  }), [
    activeDelegation,
    hasActiveExecutionGraph,
    hasStreamThinking,
    messages.length,
    pendingFinal,
    sending,
    streamText.length,
    streamTools,
    streamingTools,
    userRunCards,
  ]);

  useEffect(() => {
    if (!hasVisibleRuntimeActivity) {
      setRuntimeActivity(null);
      return;
    }
    const now = Date.now();
    setRuntimeActivity((current) => ({
      startedAt: current?.startedAt ?? now,
      lastUpdateAt: current?.signature === activitySignature ? current.lastUpdateAt : now,
      signature: activitySignature,
    }));
  }, [activitySignature, hasVisibleRuntimeActivity]);

  useEffect(() => {
    if (!runtimeActivity) return;
    setActivityClock((value) => value + 1);
    const id = window.setInterval(() => {
      setActivityClock((value) => value + 1);
    }, 1000);
    return () => window.clearInterval(id);
  }, [runtimeActivity]);

  const activitySummary = useMemo(() => {
    if (!runtimeActivity) return null;
    void activityClock;
    const now = Date.now();
    const elapsedSeconds = Math.max(0, Math.floor((now - runtimeActivity.startedAt) / 1000));
    const idleSeconds = Math.max(0, Math.floor((now - runtimeActivity.lastUpdateAt) / 1000));
    const runningTools = streamingTools
      .filter((tool) => tool.status === 'running')
      .map((tool) => tool.name || tool.id || 'tool')
      .slice(0, 3);
    const completedTools = streamingTools
      .filter((tool) => tool.status === 'completed')
      .map((tool) => tool.name || tool.id || 'tool')
      .slice(0, 3);

    let title = '\u6b63\u5728\u6267\u884c';
    if (runningTools.length > 0) {
      title = `\u6b63\u5728\u8fd0\u884c\u5de5\u5177\uff1a${runningTools.join(', ')}`;
    } else if (hasStreamTools) {
      title = '\u6b63\u5728\u51c6\u5907\u5de5\u5177\u8c03\u7528';
    } else if (activeDelegation && !hasStreamText) {
      title = '\u5df2\u6d3e\u53d1\u5b50\u4efb\u52a1\uff0c\u7b49\u5f85\u6267\u884c\u7ed3\u679c';
    } else if (hasStreamText && idleSeconds >= 90) {
      title = '\u4e0a\u4e00\u6b65\u5df2\u5b8c\u6210\uff0c\u7b49\u5f85\u6a21\u578b\u7ee7\u7eed\u8fd4\u56de';
    } else if (hasStreamText) {
      title = '\u6b63\u5728\u751f\u6210\u56de\u590d';
    } else if (pendingFinal) {
      title = completedTools.length > 0
        ? `\u5de5\u5177\u5df2\u8fd4\u56de\uff1a${completedTools.join(', ')}`
        : '\u5de5\u5177\u5df2\u8fd4\u56de\uff0c\u7b49\u5f85\u4e0b\u4e00\u6b65';
    } else if (sending) {
      title = elapsedSeconds >= 10
        ? '\u6a21\u578b\u5c1a\u672a\u8fd4\u56de\u9996\u4e2a\u4e8b\u4ef6'
        : '\u8bf7\u6c42\u5df2\u53d1\u9001\uff0c\u7b49\u5f85\u6a21\u578b\u54cd\u5e94';
    } else if (hasActiveExecutionGraph) {
      title = idleSeconds >= 90
        ? '\u6267\u884c\u4ecd\u672a\u6536\u53e3\uff0c\u7b49\u5f85\u6a21\u578b\u7ee7\u7eed\u8f93\u51fa'
        : '\u7b49\u5f85\u4efb\u52a1\u7ee7\u7eed';
    }

    const details: string[] = [
      `\u5df2\u8fd0\u884c ${formatDuration(elapsedSeconds)}`,
      idleSeconds <= 1 ? '\u521a\u521a\u6536\u5230\u8fdb\u5ea6' : `${formatDuration(idleSeconds)} \u524d\u6536\u5230\u8fdb\u5ea6`,
    ];
    if (activeDelegation?.label) {
      details.push(`\u5b50\u4efb\u52a1\uff1a${activeDelegation.label}`);
    }
    if (activeDelegation?.childSessionKey) {
      details.push(`\u4f1a\u8bdd\uff1a${activeDelegation.childSessionKey}`);
    } else if (activeDelegation?.runId) {
      details.push(`Run ID\uff1a${activeDelegation.runId}`);
    }
    if (pendingFinal && idleSeconds >= 45) {
      details.push('\u6b63\u5728\u81ea\u52a8\u56de\u8bfb\u5386\u53f2\uff0c\u786e\u8ba4\u662f\u5426\u5df2\u7ecf\u6709\u6700\u7ec8\u7ed3\u679c\u3002');
    } else if (activeDelegation && idleSeconds >= 30) {
      details.push('Main Agent \u6b63\u5728\u7b49\u5f85\u5b50\u4efb\u52a1\u8fd4\u56de\u3002');
    } else if (sending && !hasAnyStreamContent && !hasActiveExecutionGraph && elapsedSeconds >= 10) {
      details.push('\u8bf7\u6c42\u5df2\u88ab Gateway \u63a5\u53d7\uff0c\u4f46\u8fd8\u6ca1\u6709\u6536\u5230\u6a21\u578b\u7684\u9996\u4e2a delta\u3002');
      if (elapsedSeconds >= 30) {
        details.push('\u8fd9\u901a\u5e38\u8868\u793a\u6a21\u578b\u6216 provider \u6b63\u5728\u957f\u65f6\u95f4\u751f\u6210\uff0c\u800c\u4e0d\u662f\u672c\u5730 IPC \u5361\u4f4f\u3002');
      }
      if (elapsedSeconds >= 60) {
        details.push('\u590d\u6742\u4efb\u52a1\u5df2\u9644\u52a0\u5206\u5757\u6267\u884c\u6307\u4ee4\uff1b\u82e5\u6a21\u578b\u4ecd\u4e00\u6b21\u6027\u751f\u6210\u5927\u6587\u4ef6\uff0c\u9996\u5305\u4ecd\u53ef\u80fd\u8f83\u6162\u3002');
      }
    } else if (idleSeconds >= 90) {
      details.push('\u957f\u65f6\u95f4\u65e0\u65b0\u4e8b\u4ef6\uff1b\u6b63\u5728\u81ea\u52a8\u56de\u8bfb\u5386\u53f2\u5e76\u7b49\u5f85\u540e\u7eed\u8f93\u51fa\u3002');
    }
    if (idleSeconds >= 120) {
      details.push('\u5982\u679c\u4ecd\u6ca1\u6709\u65b0\u5185\u5bb9\u8fd4\u56de\uff0c\u754c\u9762\u4f1a\u81ea\u52a8\u6536\u53e3\u5e76\u4fdd\u7559\u5df2\u751f\u6210\u5185\u5bb9\u3002');
    }

    return { title, details };
  }, [
    activityClock,
    activeDelegation,
    hasAnyStreamContent,
    hasStreamText,
    hasStreamTools,
    hasActiveExecutionGraph,
    pendingFinal,
    runtimeActivity,
    sending,
    streamingTools,
  ]);
  const latestRunTriggerIndex = userRunCards.length > 0 ? userRunCards[userRunCards.length - 1]!.triggerIndex : null;
  const terminationSummary = useMemo(() => describeRunTermination(error), [error]);
  const replyTextOverrides = useMemo(() => {
    const map = new Map<number, string>();
    for (const card of userRunCards) {
      if (card.replyIndex == null) continue;
      const replyMessage = messages[card.replyIndex];
      if (!replyMessage || replyMessage.role !== 'assistant') continue;
      const fullReplyText = extractText(replyMessage);
      const trimmedReplyText = stripProcessMessagePrefix(fullReplyText, card.messageStepTexts);
      if (trimmedReplyText !== fullReplyText) {
        map.set(card.replyIndex, trimmedReplyText);
      }
    }
    return map;
  }, [userRunCards, messages]);
  const streamingReplyText = userRunCards.find((card) => card.streamingReplyText != null)?.streamingReplyText ?? null;
  const userRunCardsByTriggerIndex = useMemo(() => {
    const map = new Map<number, UserRunCard[]>();
    for (const card of userRunCards) {
      const existing = map.get(card.triggerIndex);
      if (existing) {
        existing.push(card);
      } else {
        map.set(card.triggerIndex, [card]);
      }
    }
    return map;
  }, [userRunCards]);
  const suppressedToolCardIndices = useMemo(() => {
    const indices = new Set<number>();
    for (const card of userRunCards) {
      for (let idx = card.triggerIndex + 1; idx <= card.segmentEnd; idx += 1) {
        indices.add(idx);
      }
    }
    return indices;
  }, [userRunCards]);

  // Derive the set of run keys that should be auto-collapsed (run finished
  // streaming or has a reply override) during render instead of in an effect,
  // so we don't violate react-hooks/set-state-in-effect. Explicit user toggles
  // still win via `graphExpandedOverrides` and are merged in at the call site.
  const autoCollapsedRunKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const card of userRunCards) {
      // Auto-collapse once the run is complete and a final reply exists.
      // Don't collapse while the reply is still streaming.
      const isStillStreaming = card.streamingReplyText != null;
      const shouldCollapse = !isStillStreaming && !card.active && card.replyIndex != null;
      if (!shouldCollapse) continue;
      const triggerMsg = messages[card.triggerIndex];
      const runKey = triggerMsg?.id
        ? `msg-${triggerMsg.id}`
        : `${currentSessionKey}:trigger-${card.triggerIndex}`;
      keys.add(runKey);
    }
    return keys;
  }, [currentSessionKey, messages, userRunCards]);

  useEffect(() => {
    if (userRunCards.length === 0) return;
    const current = graphStepCacheStore.get(currentSessionKey) ?? {};
    let changed = false;
    const next = { ...current };
    for (const card of userRunCards) {
      if (card.steps.length === 0) continue;
      const triggerMsg = messages[card.triggerIndex];
      const runKey = triggerMsg?.id
        ? `msg-${triggerMsg.id}`
        : `${currentSessionKey}:trigger-${card.triggerIndex}`;
      const existing = current[runKey];
      const sameSteps = !!existing
        && existing.steps.length === card.steps.length
        && existing.steps.every((step, index) => {
          const nextStep = card.steps[index];
          return nextStep
            && step.id === nextStep.id
            && step.label === nextStep.label
            && step.status === nextStep.status
            && step.kind === nextStep.kind
            && step.detail === nextStep.detail
            && step.depth === nextStep.depth
            && step.parentId === nextStep.parentId;
        });
      if (
        sameSteps
        && existing?.agentLabel === card.agentLabel
        && existing?.sessionLabel === card.sessionLabel
        && existing?.segmentEnd === card.segmentEnd
        && existing?.replyIndex === card.replyIndex
        && existing?.triggerIndex === card.triggerIndex
      ) {
        continue;
      }
      next[runKey] = {
        steps: card.steps,
        agentLabel: card.agentLabel,
        sessionLabel: card.sessionLabel,
        segmentEnd: card.segmentEnd,
        replyIndex: card.replyIndex,
        triggerIndex: card.triggerIndex,
      };
      changed = true;
    }
    if (changed) {
      graphStepCacheStore.set(currentSessionKey, next);
    }
  }, [userRunCards, messages, currentSessionKey]);

  const isDefaultAccountSwitching = useProviderStore((s) => s.isDefaultAccountSwitching);

  const chatInputElement = (
    <ChatInput
      onSend={sendMessage}
      onStop={abortRun}
      disabled={!isGatewayRunning}
      sending={sending || hasActiveExecutionGraph}
      isEmpty={isEmpty}
      initialText={editingText || prefilledInput || undefined}
      onTextChange={(text) => {
        if (prefilledInput && text !== prefilledInput) {
          setPrefilledInput(null);
        }
      }}
    />
  );

  return (
    <div
      className={cn(
        "relative flex min-h-0 flex-col -m-6 transition-colors duration-500 bg-background",
      )}
      style={{
        height: 'calc(100vh - 2.5rem)',
      }}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-0 dark:hidden"
        style={{
          background:
            'radial-gradient(120% 80% at 80% 20%, hsl(28 60% 95% / 0.85) 0%, hsl(28 50% 96% / 0.6) 35%, hsl(0 0% 100% / 0) 70%), radial-gradient(80% 60% at 20% 90%, hsl(18 80% 92% / 0.55) 0%, hsl(0 0% 100% / 0) 60%)',
        }}
      />
      {/* Toolbar */}
      <div className="relative z-10 flex shrink-0 items-center justify-between px-4 py-2">
        <ChatToolbar />
      </div>

      {/* Messages Area */}
      <div className="relative z-10 min-h-0 flex-1 overflow-hidden px-4 py-4">
        <div className="mx-auto flex h-full min-h-0 max-w-6xl flex-col gap-4 lg:flex-row lg:items-stretch">
          <div ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto">
            <div
              ref={contentRef}
              className={cn(
                "transition-all duration-300 mx-auto",
                isEmpty
                  ? "w-full max-w-3xl flex min-h-full flex-col items-center justify-center"
                  : "w-full max-w-4xl space-y-4",
              )}
            >
              {isEmpty ? (
                <>
                  <WelcomeScreen />
                  {/* Empty-state input: rendered inline under the welcome
                      block so the composer sits in the upper-middle of the
                      page, matching the design. Once messages exist the
                      composer switches to the bottom-pinned slot below. */}
                  <div className="w-full mt-2">
                    {chatInputElement}
                  </div>
                </>
              ) : (
                <>
                  {messages.map((msg, idx) => {
                    if (foldedNarrationIndices.has(idx)) return null;
                    const suppressToolCards = suppressedToolCardIndices.has(idx);
                    return (
                    <div
                      key={msg.id || `msg-${idx}`}
                      className="space-y-3"
                      id={`chat-message-${idx}`}
                      data-testid={`chat-message-${idx}`}
                    >
                      <ChatMessage
                        message={msg}
                        textOverride={replyTextOverrides.get(idx)}
                        suppressToolCards={suppressToolCards}
                        suppressProcessAttachments={suppressToolCards}
                        onEditMessage={setEditingText}
                        showEditButton={!sending && !hasActiveExecutionGraph}
                      />
                      {(userRunCardsByTriggerIndex.get(idx) ?? [])
                        .map((card) => {
                          const triggerMsg = messages[card.triggerIndex];
                          const runKey = triggerMsg?.id
                            ? `msg-${triggerMsg.id}`
                            : `${currentSessionKey}:trigger-${card.triggerIndex}`;
                          const userOverride = graphExpandedOverrides[runKey];
                          // Always use the controlled expanded prop instead of
                          // relying on ExecutionGraphCard's uncontrolled state.
                          // Uncontrolled state is lost on remount (key changes
                          // when loadHistory replaces message ids), causing
                          // spurious collapse.  The controlled prop survives
                          // remounts because it's computed fresh each render.
                          const expanded = userOverride != null
                            ? userOverride
                            : !autoCollapsedRunKeys.has(runKey);
                          return (
                            <div key={`graph-${currentSessionKey}:${card.triggerIndex}`} className="space-y-2">
                              <ExecutionGraphCard
                                agentLabel={card.agentLabel}
                                steps={card.steps}
                                active={card.active}
                                suppressThinking={card.suppressThinking}
                                isMimo={card.isMimo}
                                expanded={expanded}
                                onExpandedChange={(next) =>
                                  setGraphExpandedOverrides((prev) => ({ ...prev, [runKey]: next }))
                                }
                              />
                              {card.active && activitySummary && (
                                <RunActivityStatus summary={activitySummary} />
                              )}
                              {!card.active
                                && !sending
                                && terminationSummary
                                && latestRunTriggerIndex === card.triggerIndex && (
                                  <RunTerminationNotice summary={terminationSummary} />
                                )}
                            </div>
                          );
                        })}
                    </div>
                    );
                  })}

                  {/* Streaming message 鈥?render when reply text is separated from graph,
                      OR when there's streaming content without an active graph */}
                  {shouldRenderStreaming && (streamingReplyText != null || !hasActiveExecutionGraph) && (
                    <ChatMessage
                      message={(() => {
                        const base = streamMsg
                          ? {
                              ...(streamMsg as Record<string, unknown>),
                              role: (typeof streamMsg.role === 'string' ? streamMsg.role : 'assistant') as RawMessage['role'],
                              content: streamMsg.content ?? streamText,
                              timestamp: streamMsg.timestamp ?? streamingTimestamp,
                            }
                          : {
                              role: 'assistant' as const,
                              content: streamText,
                              timestamp: streamingTimestamp,
                            };
                        // When the reply renders as a separate bubble, strip
                        // thinking blocks from the message 鈥?they belong to
                        // the execution phase and are already omitted from
                        // the graph via omitLastStreamingMessageSegment.
                        if (streamingReplyText != null && Array.isArray(base.content)) {
                          return {
                            ...base,
                            content: (base.content as Array<{ type?: string }>).filter(
                              (block) => block.type !== 'thinking',
                            ),
                          } as RawMessage;
                        }
                        return base as RawMessage;
                      })()}
                      textOverride={streamingReplyText ?? undefined}
                      isStreaming
                      streamingTools={streamingReplyText != null ? [] : streamingTools}
                    />
                  )}

                  {showFirstResponseProgress && (
                    <FirstResponsePreparing
                      progress={firstResponseProgress}
                      warmupStatus={warmupStatus}
                    />
                  )}

                  {/* Activity indicator: waiting for next AI turn after tool execution */}
                  {sending && pendingFinal && !shouldRenderStreaming && !hasActiveExecutionGraph && activitySummary && (
                    <ActivityIndicator summary={activitySummary} />
                  )}

                  {/* Typing indicator when sending but no stream content yet */}
                  {sending && !pendingFinal && !hasAnyStreamContent && !hasActiveExecutionGraph && (
                    <TypingIndicator summary={activitySummary} mode={chatWaitingMode} />
                  )}
                </>
              )}
            </div>
          </div>

        </div>
      </div>

      {/* Security cancellation notice — user declined a confirmation; not an error */}
      {securityCancelNotice && (
        <div className="px-4 py-2 bg-muted/60 border-t border-border">
          <div className="max-w-4xl mx-auto flex items-center justify-between">
            <p className="text-sm text-muted-foreground flex items-center gap-2">
              <Info className="h-4 w-4 shrink-0" />
              {securityCancelNotice}
            </p>
            <button
              onClick={clearSecurityCancelNotice}
              className="text-xs text-muted-foreground/70 hover:text-foreground underline"
            >
              {t('common:actions.dismiss')}
            </button>
          </div>
        </div>
      )}

      {/* Error bar */}
      {error && !shouldHideRunError(error) && (
        <div className="px-4 py-2 bg-destructive/10 border-t border-destructive/20">
          <div className="max-w-4xl mx-auto flex items-center justify-between gap-3">
            <p className="text-sm text-destructive flex items-center gap-2 min-w-0">
              <AlertCircle className="h-4 w-4 flex-shrink-0" />
              <span className="truncate">{error}</span>
            </p>
            <div className="flex items-center gap-2 flex-shrink-0">
              {error.toLowerCase().includes('context overflow') && (
                <button
                  onClick={() => { clearError(); newSession(); }}
                  className="text-xs px-3 py-1 rounded bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors"
                >
                  {t('common:actions.newSession')}
                </button>
              )}
              <button
                onClick={clearError}
                className="text-xs text-destructive/60 hover:text-destructive underline"
              >
                {t('common:actions.dismiss')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Input Area — only when there are messages. The empty-state
          composer is rendered inline under the welcome block above so it
          sits in the upper-middle of the page (per design). */}
      {!isEmpty && chatInputElement}

      {/* Transparent loading overlay */}
      {minLoading && !sending && (
        <div
          data-testid="chat-history-loading-overlay"
          className="absolute inset-0 z-50 flex items-center justify-center bg-background/20 backdrop-blur-[1px] rounded-xl pointer-events-auto"
        >
          <LoaderBadge />
        </div>
      )}

      {isDefaultAccountSwitching && (
        <div
          data-testid="chat-model-switch-overlay"
          className="absolute inset-0 z-[60] flex flex-col items-center justify-center bg-background/30 backdrop-blur-[2px] pointer-events-auto"
          role="status"
          aria-live="polite"
          aria-busy="true"
        >
          <LoaderBadge />
          <p className="mt-4 text-sm text-muted-foreground">
            {t('composer.modelSwitching', { defaultValue: '正在切换模型，请稍候…' })}
          </p>
        </div>
      )}
    </div>
  );
}

// 鈹€鈹€ Welcome Screen 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

function WelcomeScreen() {
  const { t } = useTranslation('chat');
  const dingtalkUser = useDingTalkAuthStore((s) => s.user);
  const setPrefilledInput = useChatStore((s) => s.setPrefilledInput);
  const skills = useSkillsStore((s) => s.skills);
  const skillsLoading = useSkillsStore((s) => s.loading);
  const fetchSkills = useSkillsStore((s) => s.fetchSkills);
  const displayName = formatWelcomeDisplayName(dingtalkUser?.name || dingtalkUser?.nickname);
  const greetingText = displayName
    ? t('welcome.greeting', { name: displayName })
    : t('welcome.greetingFallback', { defaultValue: '你好～' });

  useEffect(() => {
    if (skills.length === 0 && !skillsLoading) {
      void fetchSkills();
    }
  }, [skills.length, skillsLoading, fetchSkills]);

  const handleQuickAction = useCallback((action: typeof WELCOME_QUICK_ACTIONS[number]) => {
    const skill = findSkillForQuickAction(skills, action.skillNames);
    const fallbackName = action.skillNames[0];
    const text = buildQuickActionComposerText(skill, fallbackName, action.defaultPrompt);
    setPrefilledInput(text);
    if (!skill) {
      toast.warning(t('welcome.skillNotInstalled', { name: fallbackName }));
    }
  }, [skills, setPrefilledInput, t]);

  return (
    <div
      className="flex w-full flex-col items-center justify-center text-center pb-3"
      data-testid="chat-welcome"
    >
      <div className="mb-4 flex items-start justify-center gap-3">
        <div
          className="flex h-12 w-8 shrink-0 items-center justify-center"
          aria-hidden
        >
          <img
            src={chatDoubleIcon}
            alt=""
            className="h-8 w-8 select-none"
            draggable={false}
          />
        </div>
        <h1
          className="text-[26px] md:text-[32px] font-medium text-foreground/85 tracking-tight leading-[1.5] text-left"
        >
          <span className="block">{greetingText}</span>
          <span className="block">{t('welcome.subtitle')}</span>
        </h1>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-2.5 max-w-2xl w-full">
        <span className="text-[13px] text-foreground/55 mr-1">
          {t('welcome.canHelpPrefix', { defaultValue: '我可以' })}
        </span>
        {WELCOME_QUICK_ACTIONS.map((action) => (
          <button
            key={action.key}
            type="button"
            data-testid={`chat-welcome-action-${action.key}`}
            onClick={() => handleQuickAction(action)}
            className="px-3.5 py-1 rounded-full text-[13px] text-[#FF922B] bg-[#FF922B]/10 hover:bg-[#FF922B]/15 dark:bg-white/5 dark:text-foreground/80 dark:hover:bg-white/10 transition-colors"
          >
            {t(action.labelKey)}
          </button>
        ))}
      </div>
    </div>
  );
}

// First Response Preparing Indicator

function FirstResponsePreparing({
  progress,
  warmupStatus,
}: {
  progress: number;
  warmupStatus?: 'idle' | 'warming' | 'ready' | 'failed';
}) {
  const { t } = useTranslation('chat');
  const [mascotSrc, setMascotSrc] = useState<string | null>(null);
  const [mascotFailed, setMascotFailed] = useState(false);
  const title = t('firstMessage.preparingTitle', {
    defaultValue: '正在准备执行...',
  });
  const description = t('firstMessage.preparingDescription', {
    defaultValue: 'Agent 正在接手并进入工作状态。',
  });

  useEffect(() => {
    let cancelled = false;
    void hostApiFetch<{ success: boolean; dataUrl?: string }>('/api/app/first-response-mascot')
      .then((result) => {
        if (!cancelled && result.success && result.dataUrl) {
          setMascotSrc(result.dataUrl);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setMascotFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex min-h-[360px] items-center justify-center px-4 py-10">
      <div
        className="flex w-full max-w-[520px] flex-col items-center rounded-[2rem] bg-card/90 px-8 py-10 text-center shadow-sm ring-1 ring-border/40 dark:bg-card/80"
        data-testid="first-response-progress-card"
        role="status"
        aria-live="polite"
      >
        {!mascotSrc || mascotFailed ? (
          <div className="mb-7 flex h-32 w-32 items-center justify-center rounded-[2rem] bg-primary/10 text-primary md:h-36 md:w-36">
            <Sparkles className="h-14 w-14" aria-hidden="true" />
          </div>
        ) : (
          <img
            src={mascotSrc}
            alt=""
            aria-hidden="true"
            className="mb-7 h-32 w-32 object-contain md:h-36 md:w-36"
            onError={() => setMascotFailed(true)}
          />
        )}
        <h2 className="text-2xl font-semibold tracking-tight text-foreground">
          {title}
        </h2>
        {description && (
          <p className="mt-4 text-base text-muted-foreground">
            {description}
          </p>
        )}
        <div className="mx-auto mt-9 h-2 w-48 overflow-hidden rounded-full bg-[#e8dfd0] dark:bg-white/10">
          <div
            className="h-full rounded-full bg-blue-500 transition-all duration-700 ease-out"
            style={{ width: `${Math.max(12, Math.min(100, progress))}%` }}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress)}
            aria-label={t('firstMessage.progressLabel', {
              progress: Math.round(progress),
              defaultValue: `Preparing first response ${Math.round(progress)}%`,
            })}
          />
        </div>
      </div>
    </div>
  );
}

// 鈹€鈹€ Typing Indicator 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

function TypingIndicator({ summary, mode }: { summary: { title: string; details: string[] } | null; mode: 'warming' | 'stuck' | 'normal' }) {
  return (
    <div className="flex gap-3">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full mt-1 bg-black/5 dark:bg-white/5 text-foreground">
        <Sparkles className="h-4 w-4" />
      </div>
      <div className="bg-black/5 dark:bg-white/5 text-foreground rounded-2xl px-4 py-3" data-testid="chat-run-activity">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
          <span>{summary?.title ?? (mode === 'stuck' ? '运行时正在恢复，稍后继续' : '请求已发送，等待模型响应')}</span>
        </div>
        {summary && (
          <p className="mt-1 text-xs text-muted-foreground/75">
            {summary.details.join(' | ')}
          </p>
        )}
        {!summary && mode === 'stuck' && (
          <p className="mt-1 text-xs text-muted-foreground/75">
            OpenClaw 报告会话处于 processing 卡住状态，正在等待运行时恢复并重新产出输出。
          </p>
        )}
      </div>
    </div>
  );
}

// 鈹€鈹€ Activity Indicator (shown between tool cycles) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

function RunActivityStatus({ summary }: { summary: { title: string; details: string[] } }) {
  void summary;
  // Temporarily hidden while we refine the execution graph progress UI.
  return null;
}

function RunTerminationNotice({ summary }: { summary: { title: string; detail: string } }) {
  return (
    <div
      className="ml-10 rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2 text-sm text-destructive/90"
      data-testid="chat-run-termination"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-2">
        <AlertCircle className="h-3.5 w-3.5 shrink-0" />
        <span className="font-medium">{summary.title}</span>
      </div>
      <div className="mt-1 text-xs text-destructive/80">
        {summary.detail}
      </div>
    </div>
  );
}

function ActivityIndicator({ summary }: { summary: { title: string; details: string[] } }) {
  return (
    <div className="flex gap-3">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full mt-1 bg-black/5 dark:bg-white/5 text-foreground">
        <Sparkles className="h-4 w-4" />
      </div>
      <div className="bg-black/5 dark:bg-white/5 text-foreground rounded-2xl px-4 py-3" data-testid="chat-run-activity">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
          <span>{summary.title}</span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground/75">
          {summary.details.join(' | ')}
        </p>
      </div>
    </div>
  );
}

export default Chat;



