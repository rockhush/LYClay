import { extractText, extractTextSegments, extractThinkingSegments, extractToolUse } from './message-utils';
import type { ContentBlock, RawMessage, ToolStatus } from '@/stores/chat';
import { parseSubagentCompletionInfo, summarizeChildRunActivity, isInterimSubagentWaitAssistantReply } from '@/lib/subagent-delegation';
import {
  isConcludingAssistantReply,
  isEmbeddedAgentFailureNoticeAssistantMessage,
  isFailedAssistantMessage,
  isRunTerminalAssistantMessage,
  isTerminalAssistantMessage,
  isToolUseStopReasonAssistantMessage,
} from '@/stores/chat/run-lifecycle';

export type {
  ChildDelegationBinding,
  InFlightChildDelegation,
  SubagentCompletionInfo,
} from '@/lib/subagent-delegation';
export {
  collectChildDelegationBindings,
  collectCompletedSubagentSessionKeys,
  findInFlightChildDelegation,
  hasPendingChildDelegation,
  isWaitingOnSubagentDelegation,
  parseAgentIdFromSessionKey,
  parseSubagentCompletionInfo,
  summarizeChildRunActivity,
} from '@/lib/subagent-delegation';

export type TaskStepStatus = 'running' | 'completed' | 'error';

export interface TaskStep {
  id: string;
  label: string;
  status: TaskStepStatus;
  kind: 'thinking' | 'tool' | 'system' | 'message' | 'model';
  detail?: string;
  depth: number;
  parentId?: string;
  /** Extracted URL for web_fetch tool, used to render a clickable link icon. */
  url?: string;
}

function getMessageMeta(message: RawMessage): Record<string, unknown> {
  return message as RawMessage & Record<string, unknown>;
}

function hasRawMediaLine(text: string): boolean {
  return /(?:^|\n)\s*MEDIA:[^\n]+/i.test(text);
}

function stripRawMediaLines(text: string): string {
  return text
    .replace(/^\s*MEDIA:[^\n]*(?:\r?\n)?/gmi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeComparableReplyText(text: string): string {
  return stripRawMediaLines(text).replace(/\s+/g, '');
}

function hasRichMediaBlock(message: RawMessage): boolean {
  if (Array.isArray(message.content)) {
    return (message.content as ContentBlock[]).some((block) =>
      block.type === 'image'
      || Boolean((block as ContentBlock & { url?: unknown; openUrl?: unknown }).url)
      || Boolean((block as ContentBlock & { url?: unknown; openUrl?: unknown }).openUrl),
    );
  }
  return false;
}

export function isGatewayInjectedAssistantMediaMessage(message: RawMessage | undefined): boolean {
  if (!message || message.role !== 'assistant') return false;
  const meta = getMessageMeta(message);
  const idempotencyKey = typeof meta.idempotencyKey === 'string' ? meta.idempotencyKey : '';
  const provider = typeof meta.provider === 'string' ? meta.provider : '';
  const model = typeof meta.model === 'string' ? meta.model : '';
  return (idempotencyKey.endsWith(':assistant-media') || (provider === 'openclaw' && model === 'gateway-injected'))
    && hasRichMediaBlock(message);
}

function areEquivalentMediaReplies(rawText: string, injectedText: string): boolean {
  const raw = normalizeComparableReplyText(rawText);
  const injected = normalizeComparableReplyText(injectedText);
  if (!raw || !injected) return false;
  return raw === injected || raw.startsWith(injected) || injected.startsWith(raw);
}

function isToolResultRole(role: unknown): boolean {
  if (!role) return false;
  const normalized = String(role).toLowerCase();
  return normalized === 'toolresult' || normalized === 'tool_result' || normalized === 'tool';
}

function findLastToolActivityIndex(messages: readonly RawMessage[]): number {
  let last = -1;
  for (let idx = 0; idx < messages.length; idx += 1) {
    const message = messages[idx];
    if (!message) continue;
    if (message.role === 'assistant' && extractToolUse(message).length > 0) last = idx;
    else if (isToolResultRole(message.role)) last = idx;
  }
  return last;
}

function isRendererSyntheticRunId(id: unknown): boolean {
  return typeof id === 'string'
    && /^run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

export function isSupersededRawMediaAssistantReply(
  messages: readonly RawMessage[],
  messageIndex: number,
): boolean {
  const message = messages[messageIndex];
  if (!message || message.role !== 'assistant') return false;
  const text = extractText(message);
  if (!hasRawMediaLine(text)) return false;

  for (let idx = messageIndex + 1; idx < messages.length; idx += 1) {
    const later = messages[idx];
    if (!later || later.role === 'user') return false;
    if (!isGatewayInjectedAssistantMediaMessage(later)) continue;
    if (areEquivalentMediaReplies(text, extractText(later))) return true;
  }

  return false;
}

/**
 * Detects the index of the "final reply" assistant message in a run segment.
 *
 * The reply is the last assistant message that carries non-empty text
 * content, regardless of whether it ALSO carries tool calls. (Mixed
 * `text + toolCall` replies are rare but real — the model can emit a parting
 * text block alongside a final tool call. Treating such a message as the
 * reply avoids mis-protecting an earlier narration as the "answer" and
 * leaking the actual last text into the fold.)
 *
 * When this returns a non-negative index, the caller should avoid folding
 * that message's text into the graph (it is the answer the user sees in the
 * chat stream). When the run is still active (streaming) the final reply is
 * produced via `streamingMessage` instead, so callers pass
 * `hasStreamingReply = true` to skip protection and let every assistant-with-
 * text message in history be folded into the graph as narration.
 */
export function findReplyMessageIndex(messages: RawMessage[], hasStreamingReply: boolean): number {
  if (hasStreamingReply) return -1;
  let fallbackFailureIdx = -1;
  let fallbackPlainIdx = -1;
  for (let idx = messages.length - 1; idx >= 0; idx -= 1) {
    const message = messages[idx];
    if (!message || message.role !== 'assistant') continue;
    if (isSupersededRawMediaAssistantReply(messages, idx)) continue;
    if (extractText(message).trim().length === 0) continue;
    // Internal subagent completion markers ("[Internal task completion event]")
    // carry text but are never the user-facing reply. If picked, the real
    // parent wrap-up reply would be folded into the graph and the completion
    // marker itself is not rendered — leaving only "subagent run 完成".
    if (parseSubagentCompletionInfo(message)) continue;
    if (isInterimSubagentWaitAssistantReply(message)) continue;
    const replyText = extractText(message).trim();
    if (isSubagentOrchestrationNarration(replyText)) continue;
    if (extractToolUse(message).some((tool) => /sessions_spawn/i.test(tool.name))) continue;
    if (isFailedAssistantMessage(message) || isEmbeddedAgentFailureNoticeAssistantMessage(message)) {
      if (fallbackFailureIdx < 0) fallbackFailureIdx = idx;
      continue;
    }
    // Gateway tool rounds are intermediate narration, never the user-facing bubble.
    if (isToolUseStopReasonAssistantMessage(message)) continue;
    if (isTerminalAssistantMessage(message)) {
      return idx;
    }
    if (isConcludingAssistantReply(message, messages)) {
      // Pure-text concluding replies, or gateway bundled finals with explicit stop.
      if (extractToolUse(message).length === 0 || isRunTerminalAssistantMessage(message)) {
        return idx;
      }
      continue;
    }
    if (fallbackPlainIdx < 0 && extractToolUse(message).length === 0) {
      fallbackPlainIdx = idx;
    }
  }
  return fallbackPlainIdx >= 0 ? fallbackPlainIdx : fallbackFailureIdx;
}

/**
 * Strict variant used to detect replies that are already committed to history.
 * Unlike findReplyMessageIndex, this never falls back to an arbitrary plain
 * assistant text, because active streaming can mirror partial text into history.
 */
export function findCommittedReplyMessageIndex(messages: RawMessage[]): number {
  for (let idx = messages.length - 1; idx >= 0; idx -= 1) {
    const message = messages[idx];
    if (!message || message.role !== 'assistant') continue;
    if (isSupersededRawMediaAssistantReply(messages, idx)) continue;
    if (extractText(message).trim().length === 0) continue;
    if (parseSubagentCompletionInfo(message)) continue;
    if (isInterimSubagentWaitAssistantReply(message)) continue;
    const replyText = extractText(message).trim();
    if (isSubagentOrchestrationNarration(replyText)) continue;
    if (extractToolUse(message).some((tool) => /sessions_spawn/i.test(tool.name))) continue;
    if (isFailedAssistantMessage(message) || isEmbeddedAgentFailureNoticeAssistantMessage(message)) continue;
    if (isToolUseStopReasonAssistantMessage(message)) continue;
    if (isTerminalAssistantMessage(message)) return idx;
    if (isConcludingAssistantReply(message, messages)) {
      if (extractToolUse(message).length === 0 || isRunTerminalAssistantMessage(message)) {
        return idx;
      }
    }
  }
  const lastToolActivityIndex = findLastToolActivityIndex(messages);
  if (lastToolActivityIndex >= 0) {
    for (let idx = messages.length - 1; idx > lastToolActivityIndex; idx -= 1) {
      const message = messages[idx];
      if (!message || message.role !== 'assistant') continue;
      if (!isRendererSyntheticRunId(message.id)) continue;
      if (extractToolUse(message).length > 0) continue;
      if (extractText(message).trim().length === 0) continue;
      if (isFailedAssistantMessage(message) || isEmbeddedAgentFailureNoticeAssistantMessage(message)) continue;
      if (parseSubagentCompletionInfo(message)) continue;
      if (isInterimSubagentWaitAssistantReply(message)) continue;
      if (isSubagentOrchestrationNarration(extractText(message).trim())) continue;
      return idx;
    }
  }

  return -1;
}

export function committedReplyShouldSettleExecutionGraph(input: {
  committedReplyOffset: number;
  isUserTurnExecuting: boolean;
  hasAnyStreamContent: boolean;
  segmentDelegationOpen: boolean;
  segmentHasPendingChild: boolean;
  segmentWaitingOnSubagent: boolean;
  stalledChildSessionKey?: string | null;
}): boolean {
  return input.committedReplyOffset !== -1
    && !input.isUserTurnExecuting
    && !input.segmentDelegationOpen
    && !input.segmentHasPendingChild
    && !input.segmentWaitingOnSubagent
    && !input.stalledChildSessionKey;
}

export function shouldPromoteStreamingTextAsReply(input: {
  streamText: string;
  hasStreamImages: boolean;
  streamToolUseCount: number;
}): boolean {
  if (input.hasStreamImages) return true;
  if (!input.streamText.trim()) return false;
  // Process narration that accompanies a live tool call stays in the graph.
  return input.streamToolUseCount === 0;
}

interface DeriveTaskStepsInput {
  messages: RawMessage[];
  streamingMessage: unknown | null;
  streamingTools: ToolStatus[];
  omitLastStreamingMessageSegment?: boolean;
  includeHiddenToolSteps?: boolean;
  committedReplyIndex?: number | null;
}

function normalizeText(text: string | null | undefined): string | undefined {
  if (!text) return undefined;
  const normalized = text.replace(/[ \t]+/g, ' ').trim();
  if (!normalized) return undefined;
  return normalized;
}

function makeToolId(prefix: string, name: string, index: number): string {
  return `${prefix}:${name}:${index}`;
}

function hasThinkingBlock(message: RawMessage): boolean {
  if (!Array.isArray(message.content)) return false;
  return (message.content as ContentBlock[]).some((block) => block.type === 'thinking');
}

/**
 * Tool name prefixes shown as wrench rows in the execution graph.
 * Extend this list to reveal additional tool types in the UI.
 */
export const EXECUTION_GRAPH_VISIBLE_TOOL_NAME_PREFIXES = ['read', 'write', 'edit'] as const;

export function isVisibleExecutionGraphToolName(name: string | undefined | null): boolean {
  if (!name) return false;
  const normalized = name.trim().toLowerCase();
  return EXECUTION_GRAPH_VISIBLE_TOOL_NAME_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(prefix),
  );
}

/** OpenClaw session orchestration tools — hidden from the execution graph UI. */
export function isSubagentOrchestrationToolName(name: string | undefined | null): boolean {
  if (!name) return false;
  return /^(sessions_spawn|sessions_yield)$/i.test(name.trim());
}

/** Tools not on {@link EXECUTION_GRAPH_VISIBLE_TOOL_NAME_PREFIXES} are hidden from the graph. */
export function isHiddenExecutionGraphToolName(name: string | undefined | null): boolean {
  if (!name) return false;
  return !isVisibleExecutionGraphToolName(name);
}

function isSubagentOrchestrationStep(step: TaskStep): boolean {
  if (step.kind === 'tool' && isSubagentOrchestrationToolName(step.label)) return true;
  if (step.kind === 'system' && /\bsubagent\b/i.test(step.label)) return true;
  if (step.kind === 'system' && /\brun$/i.test(step.label) && /Spawned branch/i.test(step.detail ?? '')) return true;
  return false;
}

export function isSubagentOrchestrationNarration(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  if (/sessions_(spawn|yield)/i.test(normalized)) return true;
  if (/调度子\s*agent/i.test(normalized)) return true;
  if (/(?:spawn|派发|启动|调度).{0,24}sub\s*agent/i.test(normalized)) return true;
  if (/(?:子\s*agent|子\s*任务|子智能体).{0,30}(?:执行|派发|调度|spawn|yield|生成)/i.test(normalized)) return true;
  if (/(?:I'll|let me).{0,24}spawn.{0,24}sub-?agent/i.test(normalized)) return true;
  if (/PPT 正在由子智能体生成中/i.test(normalized)) return true;
  if (/PPT 正在生成中/i.test(normalized)) return true;
  if (/生成完成后我会通知你/i.test(normalized)) return true;
  return false;
}

function isSpawnLikeStep(label: string): boolean {
  if (isSubagentOrchestrationToolName(label)) return false;
  return /(spawn|subagent|delegate|parallel)/i.test(label);
}

export function filterSubagentOrchestrationSteps(steps: TaskStep[]): TaskStep[] {
  return steps.filter((step) => !isSubagentOrchestrationStep(step));
}

function isHiddenExecutionGraphStep(step: TaskStep): boolean {
  return step.kind === 'tool' && step.depth <= 1 && isHiddenExecutionGraphToolName(step.label);
}

export function filterHiddenExecutionGraphSteps(steps: TaskStep[]): TaskStep[] {
  return steps.filter((step) => !isHiddenExecutionGraphStep(step));
}

function tryParseJsonObject(detail: string | undefined): Record<string, unknown> | null {
  if (!detail) return null;
  try {
    const parsed = JSON.parse(detail) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function extractBranchAgent(step: TaskStep): string | null {
  const parsed = tryParseJsonObject(step.detail);
  const agentId = parsed?.agentId;
  if (typeof agentId === 'string' && agentId.trim()) return agentId.trim();

  // sessions_spawn often identifies the work by task name rather than agentId
  // (e.g. { taskName: 'ppt_digital_employee', task: '…' }). Prefer those so the
  // branch reads "<task> run" instead of a generic "subagent run".
  const label = parsed?.label;
  if (typeof label === 'string' && label.trim()) return label.trim();
  const taskName = parsed?.taskName;
  if (typeof taskName === 'string' && taskName.trim()) return taskName.trim();

  const message = typeof parsed?.message === 'string' ? parsed.message : step.detail;
  if (!message) return null;
  const match = message.match(/\b(coder|reviewer|project-manager|manager|planner|researcher|worker|subagent)\b/i);
  return match ? match[1] : null;
}

function attachTopology(steps: TaskStep[]): TaskStep[] {
  const withTopology: TaskStep[] = [];
  let activeBranchNodeId: string | null = null;

  for (const step of steps) {
    if (step.kind === 'system') {
      activeBranchNodeId = null;
      withTopology.push({ ...step, depth: 1, parentId: 'agent-run' });
      continue;
    }

    if (/sessions_spawn/i.test(step.label)) {
      const branchAgent = extractBranchAgent(step) || 'subagent';
      const branchNodeId = `${step.id}:branch`;
      withTopology.push({ ...step, depth: 1, parentId: 'agent-run' });
      withTopology.push({
        id: branchNodeId,
        label: `${branchAgent} run`,
        status: step.status,
        kind: 'system',
        detail: `Spawned branch for ${branchAgent}`,
        depth: 2,
        parentId: step.id,
      });
      // The branch only hosts the CHILD session's own steps, which are attached
      // separately via attachSubagentChildSteps. The parent's subsequent inline
      // steps (e.g. it continues working after a subagent times out) are
      // parent-level — do NOT keep nesting them under the branch.
      activeBranchNodeId = null;
      continue;
    }

    if (/sessions_yield/i.test(step.label)) {
      withTopology.push({
        ...step,
        depth: activeBranchNodeId ? 3 : 1,
        parentId: activeBranchNodeId ?? 'agent-run',
      });
      activeBranchNodeId = null;
      continue;
    }

    if (step.kind === 'thinking' || step.kind === 'message' || step.kind === 'model') {
      withTopology.push({
        ...step,
        depth: activeBranchNodeId ? 3 : 1,
        parentId: activeBranchNodeId ?? 'agent-run',
      });
      continue;
    }

    if (isSpawnLikeStep(step.label)) {
      activeBranchNodeId = step.id;
      withTopology.push({
        ...step,
        depth: 1,
        parentId: 'agent-run',
      });
      continue;
    }

    withTopology.push({
      ...step,
      depth: activeBranchNodeId ? 3 : 1,
      parentId: activeBranchNodeId ?? 'agent-run',
    });
  }

  return withTopology;
}

function appendDetailSegments(
  segments: string[],
  options: {
    idPrefix: string;
    label: string;
    kind: Extract<TaskStep['kind'], 'thinking' | 'message'>;
    running: boolean;
    upsertStep: (step: TaskStep) => void;
  },
): void {
  const normalizedSegments = segments
    .map((segment) => normalizeText(segment))
    .filter((segment): segment is string => !!segment)
    .filter((segment) => !isModelCommandApprovalNarration(segment));

  normalizedSegments.forEach((detail, index) => {
    const isLast = index === normalizedSegments.length - 1;
    const isRunning = options.running && isLast;
    options.upsertStep({
      id: `${options.idPrefix}-${index}`,
      label: options.label,
      status: isRunning ? 'running' : 'completed',
      kind: options.kind,
      detail,
      depth: 1,
    });
  });
}

function isModelCommandApprovalNarration(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  if (/\/approve\s+[a-z0-9_-]+/i.test(normalized) && normalized.length <= 160) return true;

  const hasApprovalPhrase = /(?:需要|请).{0,12}(?:批准|准许|确认|允许).{0,12}(?:执行|运行|查看|搜索|列出|检查|确认|放行|命令|操作)/i.test(normalized)
    || /请\s*(?:批准|准许|确认|允许).{0,16}(?:初始化|生成|创建)/i.test(normalized)
    || /\b(?:please\s+)?(?:approve|confirm|allow)\s+(?:running|executing|checking|listing|searching)\b/i.test(normalized);
  if (!hasApprovalPhrase) return false;

  // 只隐藏带明显命令片段的伪审批话术；普通“请确认需求”不应被过滤。
  return /\/approve\s+[a-z0-9_-]+/i.test(normalized)
    || /(?:^|[\s:：])(?:>\s*)?(?:`[^`]+`|(?:python3?|node|npm|pnpm|yarn|uv|uvx|dir|ls|cd|findstr|grep|Get-ChildItem|Select-String|powershell|cmd)(?:\s|$|[\\/]))/i.test(normalized)
    || /[A-Za-z]:\\/.test(normalized)
    || /\$env:[A-Za-z_][A-Za-z0-9_]*/i.test(normalized);
}

export function deriveTaskSteps({
  messages,
  streamingMessage,
  streamingTools,
  omitLastStreamingMessageSegment = false,
  includeHiddenToolSteps = false,
  committedReplyIndex = null,
}: DeriveTaskStepsInput): TaskStep[] {
  const steps: TaskStep[] = [];
  const stepIndexById = new Map<string, number>();

  const upsertStep = (step: TaskStep): void => {
    const existingIndex = stepIndexById.get(step.id);
    if (existingIndex == null) {
      stepIndexById.set(step.id, steps.length);
      steps.push(step);
      return;
    }
    const existing = steps[existingIndex];
    steps[existingIndex] = {
      ...existing,
      ...step,
      detail: step.detail ?? existing.detail,
    };
  };

  const streamMessage = streamingMessage && typeof streamingMessage === 'object'
    ? streamingMessage as RawMessage
    : null;

  // The final answer the user sees as a chat bubble. We avoid folding it into
  // the graph to prevent duplication. When a run is still streaming, the
  // reply lives in `streamingMessage`, so every pure-text assistant message in
  // `messages` is treated as intermediate narration.
  const replyIndex = typeof committedReplyIndex === 'number' && committedReplyIndex >= 0
    ? committedReplyIndex
    : findReplyMessageIndex(messages, streamMessage != null);

  for (const [messageIndex, message] of messages.entries()) {
    if (!message || message.role !== 'assistant') continue;
    if (isSupersededRawMediaAssistantReply(messages, messageIndex)) continue;

    if (messageIndex !== replyIndex) {
      appendDetailSegments(extractThinkingSegments(message), {
        idPrefix: `history-thinking-${message.id || messageIndex}`,
        label: 'Thinking',
        kind: 'thinking',
        running: false,
        upsertStep,
      });
    }

    const toolUses = extractToolUse(message);
    // Fold any intermediate assistant text into the graph as a narration
    // step — including text that lives on a mixed `text + toolCall` message.
    // The narration step is emitted BEFORE the tool steps so the graph
    // preserves the original ordering (the assistant "thinks out loud" and
    // then invokes the tool).
    const narrationSegments = extractTextSegments(message);
    const graphNarrationSegments = messageIndex === replyIndex
      ? narrationSegments.slice(0, -1)
      : narrationSegments;
    appendDetailSegments(graphNarrationSegments, {
      idPrefix: `history-message-${message.id || messageIndex}`,
      label: 'Message',
      kind: 'message',
      running: false,
      upsertStep,
    });

    toolUses.forEach((tool, index) => {
      const input = tool.input as Record<string, unknown>;
      const url = tool.name === 'web_fetch' && typeof input?.url === 'string' ? input.url : undefined;
      upsertStep({
        id: tool.id || makeToolId(`history-tool-${message.id || messageIndex}`, tool.name, index),
        label: tool.name,
        status: 'completed',
        kind: 'tool',
        detail: normalizeText(JSON.stringify(tool.input, null, 2)),
        depth: 1,
        url,
      });
    });
  }

  if (streamMessage) {
    // When the reply is being rendered as a separate bubble
    // (omitLastStreamingMessageSegment), thinking that accompanies
    // the reply belongs to the bubble — omit it from the graph.
    if (!omitLastStreamingMessageSegment) {
      const thinkingSegments = extractThinkingSegments(streamMessage);
      appendDetailSegments(thinkingSegments, {
        idPrefix: 'stream-thinking',
        label: 'Thinking',
        kind: 'thinking',
        running: true,
        upsertStep,
      });
      if (thinkingSegments.length === 0 && hasThinkingBlock(streamMessage)) {
        upsertStep({
          id: 'stream-thinking-0',
          label: 'Thinking',
          status: 'running',
          kind: 'thinking',
          depth: 1,
        });
      }
    }

    // Stream-time narration should also appear in the execution graph so that
    // intermediate process output stays in P1 instead of leaking into the
    // assistant reply area.
    const streamNarrationSegments = extractTextSegments(streamMessage);
    const graphStreamNarrationSegments = omitLastStreamingMessageSegment
      ? streamNarrationSegments.slice(0, -1)
      : streamNarrationSegments;
    appendDetailSegments(graphStreamNarrationSegments, {
      idPrefix: 'stream-message',
      label: 'Message',
      kind: 'message',
      running: !omitLastStreamingMessageSegment,
      upsertStep,
    });
  }

  const activeToolIds = new Set<string>();
  const activeToolNamesWithoutIds = new Set<string>();
  streamingTools.forEach((tool, index) => {
    const id = tool.toolCallId || tool.id || makeToolId('stream-status', tool.name, index);
    activeToolIds.add(id);
    if (!tool.toolCallId && !tool.id) {
      activeToolNamesWithoutIds.add(tool.name);
    }
    upsertStep({
      id,
      label: tool.name,
      status: tool.status,
      kind: 'tool',
      detail: normalizeText(tool.summary),
      depth: 1,
    });
  });

  if (streamMessage) {
    extractToolUse(streamMessage).forEach((tool, index) => {
      const id = tool.id || makeToolId('stream-tool', tool.name, index);
      if (activeToolIds.has(id) || activeToolNamesWithoutIds.has(tool.name)) return;
      const input = tool.input as Record<string, unknown>;
      const url = tool.name === 'web_fetch' && typeof input?.url === 'string' ? input.url : undefined;
      upsertStep({
        id,
        label: tool.name,
        status: 'running',
        kind: 'tool',
        detail: normalizeText(JSON.stringify(tool.input, null, 2)),
        depth: 1,
        url,
      });
    });
  }

  const topology = attachTopology(steps);
  return includeHiddenToolSteps ? topology : filterHiddenExecutionGraphSteps(topology);
}

export function findLatestSpawnStepId(steps: TaskStep[]): string | null {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    if (/sessions_spawn/i.test(steps[i].label)) return steps[i].id;
  }
  return null;
}

function findSubagentBranchNodeId(steps: TaskStep[], spawnStepId?: string | null): string | null {
  if (spawnStepId) {
    const branchId = `${spawnStepId}:branch`;
    if (steps.some((step) => step.id === branchId)) return branchId;
  }
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i];
    if (step.kind === 'system' && /Spawned branch/i.test(step.detail ?? '')) {
      return step.id;
    }
  }
  return null;
}

function resolveSubagentBranchNode(
  parentSteps: TaskStep[],
  branchKey: string,
  branchLabel?: string | null,
  spawnStepId?: string | null,
  childRunning = false,
  childActivityDetail?: string | null,
  childError = false,
): { steps: TaskStep[]; branchNodeId: string } {
  const resolvedSpawnStepId = spawnStepId ?? findLatestSpawnStepId(parentSteps);
  let branchNodeId = findSubagentBranchNodeId(parentSteps, resolvedSpawnStepId);
  const name = branchLabel?.trim() || 'subagent';
  const detail = childError
    ? (childActivityDetail?.trim() || '子 Agent 长时间无进展，可能已在模型调用中卡住')
    : (childActivityDetail?.trim()
      || (childRunning ? '子 Agent 正在后台执行' : `Subagent: ${name}`));
  if (!branchNodeId) {
    // Prefer pinning the new branch to its spawn step so child steps nest under
    // the same `${spawnStepId}:branch` node the parent graph already uses.
    branchNodeId = resolvedSpawnStepId ? `${resolvedSpawnStepId}:branch` : `${branchKey}:branch`;
    return {
      branchNodeId,
      steps: [
        ...parentSteps,
        {
          id: branchNodeId,
          label: `${name} run`,
          status: childError ? 'error' : (childRunning ? 'running' : 'completed'),
          kind: 'system',
          detail,
          depth: 2,
          parentId: resolvedSpawnStepId ?? 'agent-run',
        },
      ],
    };
  }

  // Preserve the branch label that the parent graph already produced (e.g.
  // "coder run"); only the live status/detail needs to track child progress.
  return {
    branchNodeId,
    steps: parentSteps.map((step) => {
      if (step.id !== branchNodeId) return step;
      return {
        ...step,
        detail,
        status: childError ? 'error' : (childRunning ? 'running' : step.status),
      };
    }),
  };
}

/** Nest child transcript steps under the parent spawn branch in the execution graph. */
export function attachSubagentChildSteps(
  parentSteps: TaskStep[],
  childMessages: RawMessage[],
  branchKey: string,
  options?: {
    branchLabel?: string | null;
    spawnStepId?: string | null;
    /** Keep the branch running while the child session is still in flight on the backend. */
    forceChildRunning?: boolean;
    /** Mark the branch as failed when the child session stalled without completion. */
    forceChildError?: boolean;
  },
): TaskStep[] {
  const childActivityDetail = summarizeChildRunActivity(childMessages);
  const childError = options?.forceChildError ?? false;
  if (childMessages.length === 0) {
    return resolveSubagentBranchNode(
      parentSteps,
      branchKey,
      options?.branchLabel,
      options?.spawnStepId,
      options?.forceChildRunning ?? true,
      childActivityDetail,
      childError,
    ).steps;
  }

  const childDerived = deriveTaskSteps({
    messages: childMessages,
    streamingMessage: null,
    streamingTools: [],
    includeHiddenToolSteps: true,
  });
  const childRunning = !childError && (
    options?.forceChildRunning
    || childDerived.some((step) => step.status === 'running')
  );
  const { steps: withBranch, branchNodeId } = resolveSubagentBranchNode(
    parentSteps,
    branchKey,
    options?.branchLabel,
    options?.spawnStepId,
    childRunning,
    childActivityDetail,
    childError,
  );

  const existingIds = new Set(withBranch.map((step) => step.id));
  const nestedChildSteps = childDerived
    .map((step) => ({
      ...step,
      id: `${branchKey}:${step.id}`,
      depth: 2 + step.depth,
      parentId: step.parentId && step.parentId !== 'agent-run'
        ? `${branchKey}:${step.parentId}`
        : branchNodeId,
    }))
    .filter((step) => !existingIds.has(step.id));

  return [...withBranch, ...nestedChildSteps];
}
