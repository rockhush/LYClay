import { extractText, extractTextSegments, extractThinkingSegments, extractToolUse } from './message-utils';
import type { ContentBlock, RawMessage, ToolStatus } from '@/stores/chat';

export type TaskStepStatus = 'running' | 'completed' | 'error';

export interface TaskStep {
  id: string;
  label: string;
  status: TaskStepStatus;
  kind: 'thinking' | 'tool' | 'system' | 'message' | 'model';
  detail?: string;
  durationMs?: number;
  depth: number;
  parentId?: string;
  /** Extracted URL for web_fetch tool, used to render a clickable link icon. */
  url?: string;
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
  for (let idx = messages.length - 1; idx >= 0; idx -= 1) {
    const message = messages[idx];
    if (!message || message.role !== 'assistant') continue;
    if (extractText(message).trim().length === 0) continue;
    return idx;
  }
  return -1;
}

interface DeriveTaskStepsInput {
  messages: RawMessage[];
  streamingMessage: unknown | null;
  streamingTools: ToolStatus[];
  omitLastStreamingMessageSegment?: boolean;
  toolDurationByToolCallId?: ReadonlyMap<string, number> | Record<string, number>;
}

function lookupToolDuration(
  toolCallId: string | undefined,
  toolDurationByToolCallId?: ReadonlyMap<string, number> | Record<string, number>,
): number | undefined {
  if (!toolCallId || !toolDurationByToolCallId) return undefined;
  if (toolDurationByToolCallId instanceof Map) return toolDurationByToolCallId.get(toolCallId);
  return toolDurationByToolCallId[toolCallId];
}

export interface SubagentCompletionInfo {
  sessionKey: string;
  sessionId: string;
  agentId: string;
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

export function parseAgentIdFromSessionKey(sessionKey: string): string | null {
  const parts = sessionKey.split(':');
  if (parts.length < 2 || parts[0] !== 'agent') return null;
  return parts[1] || null;
}

export function parseSubagentCompletionInfo(message: RawMessage): SubagentCompletionInfo | null {
  const text = typeof message.content === 'string'
    ? message.content
    : Array.isArray(message.content)
      ? message.content.map((block) => ('text' in block && typeof block.text === 'string' ? block.text : '')).join('\n')
      : '';
  if (!text.includes('[Internal task completion event]')) return null;

  const sessionKeyMatch = text.match(/session_key:\s*(.+)/);
  const sessionIdMatch = text.match(/session_id:\s*(.+)/);
  const sessionKey = sessionKeyMatch?.[1]?.trim();
  const sessionId = sessionIdMatch?.[1]?.trim();
  if (!sessionKey || !sessionId) return null;
  const agentId = parseAgentIdFromSessionKey(sessionKey);
  if (!agentId) return null;
  return { sessionKey, sessionId, agentId };
}

export interface InFlightChildDelegation {
  label: string | null;
  childSessionKey: string;
  runId: string | null;
}

function isToolResultMessage(message: RawMessage | undefined): boolean {
  if (!message) return false;
  const role = String(message.role || '').toLowerCase();
  return role === 'toolresult' || role === 'tool_result' || role === 'tool';
}

/**
 * Detect a spawned subagent that is still running (spawn accepted, no completion
 * event in history yet). Used to poll child transcripts and surface progress
 * while the parent run is waiting on the delegate.
 */
export function findInFlightChildDelegation(
  messages: RawMessage[],
  completedChildSessionKeys: ReadonlySet<string>,
  runtimeActive: boolean,
): InFlightChildDelegation | null {
  if (!runtimeActive) return null;

  type SpawnCall = { toolCallId: string | null; label: string | null; messageIndex: number };
  let latestSpawn: SpawnCall | null = null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== 'assistant') continue;
    for (const tool of extractToolUse(message)) {
      if (!/sessions_spawn/i.test(tool.name)) continue;
      const input = tool.input && typeof tool.input === 'object'
        ? tool.input as Record<string, unknown>
        : null;
      latestSpawn = {
        toolCallId: tool.id || null,
        label: typeof input?.label === 'string' ? input.label : null,
        messageIndex: i,
      };
      break;
    }
    if (latestSpawn) break;
  }
  if (!latestSpawn) return null;

  let childSessionKey: string | null = null;
  let runId: string | null = null;
  for (let i = messages.length - 1; i > latestSpawn.messageIndex; i -= 1) {
    const message = messages[i];
    if (!isToolResultMessage(message)) continue;
    if (latestSpawn.toolCallId && message.toolCallId && message.toolCallId !== latestSpawn.toolCallId) {
      continue;
    }
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

  if (!childSessionKey || completedChildSessionKeys.has(childSessionKey)) return null;
  return {
    label: latestSpawn.label,
    childSessionKey,
    runId,
  };
}

/** OpenClaw session orchestration tools — hidden from the execution graph UI. */
export function isSubagentOrchestrationToolName(name: string | undefined | null): boolean {
  if (!name) return false;
  return /^(sessions_spawn|sessions_yield)$/i.test(name.trim());
}

function isSubagentOrchestrationStep(step: TaskStep): boolean {
  if (step.kind === 'tool' && isSubagentOrchestrationToolName(step.label)) return true;
  if (step.kind === 'system' && /\bsubagent\b/i.test(step.label)) return true;
  if (step.kind === 'system' && /\brun$/i.test(step.label) && /Spawned branch/i.test(step.detail ?? '')) return true;
  return false;
}

function isSubagentOrchestrationNarration(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  if (/sessions_(spawn|yield)/i.test(normalized)) return true;
  if (/调度子\s*agent/i.test(normalized)) return true;
  if (/(?:spawn|派发|启动|调度).{0,24}sub\s*agent/i.test(normalized)) return true;
  if (/(?:子\s*agent|子\s*任务).{0,30}(?:执行|派发|调度|spawn|yield)/i.test(normalized)) return true;
  return false;
}

function isSpawnLikeStep(label: string): boolean {
  if (isSubagentOrchestrationToolName(label)) return false;
  return /(spawn|subagent|delegate|parallel)/i.test(label);
}

export function filterSubagentOrchestrationSteps(steps: TaskStep[]): TaskStep[] {
  return steps.filter((step) => !isSubagentOrchestrationStep(step));
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
      activeBranchNodeId = branchNodeId;
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
    .filter((segment) => !isModelCommandApprovalNarration(segment))
    .filter((segment) => !isSubagentOrchestrationNarration(segment));

  normalizedSegments.forEach((detail, index) => {
    options.upsertStep({
      id: `${options.idPrefix}-${index}`,
      label: options.label,
      status: options.running && index === normalizedSegments.length - 1 ? 'running' : 'completed',
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
  toolDurationByToolCallId,
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
  const replyIndex = findReplyMessageIndex(messages, streamMessage != null);

  for (const [messageIndex, message] of messages.entries()) {
    if (!message || message.role !== 'assistant') continue;

    const modelCallDurationMs = message._modelCallDurationMs;
    if (typeof modelCallDurationMs === 'number' && modelCallDurationMs > 0) {
      upsertStep({
        id: `history-model-${message.id || messageIndex}`,
        label: 'Model',
        status: 'completed',
        kind: 'model',
        durationMs: modelCallDurationMs,
        depth: 1,
      });
    }

    appendDetailSegments(extractThinkingSegments(message), {
      idPrefix: `history-thinking-${message.id || messageIndex}`,
      label: 'Thinking',
      kind: 'thinking',
      running: false,
      upsertStep,
    });

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
      if (isSubagentOrchestrationToolName(tool.name)) return;
      const input = tool.input as Record<string, unknown>;
      const url = tool.name === 'web_fetch' && typeof input?.url === 'string' ? input.url : undefined;
      upsertStep({
        id: tool.id || makeToolId(`history-tool-${message.id || messageIndex}`, tool.name, index),
        label: tool.name,
        status: 'completed',
        kind: 'tool',
        detail: normalizeText(JSON.stringify(tool.input, null, 2)),
        durationMs: lookupToolDuration(tool.id, toolDurationByToolCallId),
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
          id: 'stream-thinking-empty',
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
    if (isSubagentOrchestrationToolName(tool.name)) return;
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
      durationMs: tool.durationMs,
      depth: 1,
    });
  });

  if (streamMessage) {
    extractToolUse(streamMessage).forEach((tool, index) => {
      if (isSubagentOrchestrationToolName(tool.name)) return;
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

  return attachTopology(steps);
}
