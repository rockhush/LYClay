import { extractText, extractToolUse } from '@/pages/Chat/message-utils';
import type { RawMessage } from '@/stores/chat';
import {
  findConcludingAssistantReply,
  findLatestVisibleUserIndex,
  isRunTerminalAssistantMessage,
  shouldSilentlyFinalizeRunOnAssistantFinal,
} from '@/stores/chat/run-lifecycle';
import { hasActiveChildDelegations, isChildDelegationStillActive } from '@/lib/subagent-delegation-watch';

export interface SubagentCompletionInfo {
  sessionKey: string;
  sessionId: string;
  agentId: string;
}

export interface InFlightChildDelegation {
  label: string | null;
  childSessionKey: string;
  runId: string | null;
}

export interface ChildDelegationBinding {
  childSessionKey: string;
  spawnToolCallId: string | null;
  label: string | null;
  spawnMessageIndex: number;
  completed: boolean;
  runId: string | null;
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

function isToolResultMessage(message: RawMessage | undefined): boolean {
  if (!message) return false;
  const role = String(message.role || '').toLowerCase();
  return role === 'toolresult' || role === 'tool_result' || role === 'tool';
}

/** Gateway run that delivers the parent's wrap-up after a delegated child completes. */
export function isSubagentDelegationAnnounceRun(runId: string): boolean {
  return runId.startsWith('announce:') && runId.includes(':subagent:');
}

/**
 * Recover the child session key embedded in an auto-announce wrap-up run id.
 *
 * Format: `announce:v1:<childSessionKey>:<gatewayRunId>` where `childSessionKey`
 * is itself colon-delimited (e.g. `agent:main:subagent:<uuid>`) and the trailing
 * segment is the child's gateway run id. The child that TRIGGERS the parent's
 * announce wrap-up never gets an `[Internal task completion event]` written to
 * the parent transcript (only later-finishing siblings do), so this run id is
 * the only signal that that child has finished — without it, its execution-graph
 * branch is stranded "running" forever.
 */
export function parseChildSessionKeyFromAnnounceRun(runId: string): string | null {
  if (!isSubagentDelegationAnnounceRun(runId)) return null;
  const withoutPrefix = runId.replace(/^announce:v\d+:/, '');
  const parts = withoutPrefix.split(':');
  const subagentIdx = parts.indexOf('subagent');
  // Need `subagent`, the child id, and the trailing gateway run id.
  if (subagentIdx < 0 || parts.length < subagentIdx + 3) return null;
  const childKey = parts.slice(0, subagentIdx + 2).join(':');
  return childKey || null;
}

export function parseAgentIdFromSessionKey(sessionKey: string): string | null {
  const parts = sessionKey.split(':');
  if (parts.length < 2 || parts[0] !== 'agent') return null;
  return parts[1] || null;
}

/** Child delegation sessions embed `:subagent:` in the session key. */
export function isSubagentSessionKey(sessionKey: string): boolean {
  return sessionKey.includes(':subagent:');
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

export function collectCompletedSubagentSessionKeys(messages: RawMessage[]): Set<string> {
  const keys = new Set<string>();
  for (const message of messages) {
    const info = parseSubagentCompletionInfo(message);
    if (info) keys.add(info.sessionKey);
  }
  return keys;
}

/** A committed tool result exists for the spawn at `spawnIndex` (matching `toolId` when present). */
function spawnResultCommitted(
  messages: readonly RawMessage[],
  spawnIndex: number,
  toolId: string | null,
): boolean {
  for (let j = spawnIndex + 1; j < messages.length; j += 1) {
    const candidate = messages[j];
    if (!isToolResultMessage(candidate)) continue;
    if (toolId && candidate.toolCallId && candidate.toolCallId !== toolId) continue;
    return true;
  }
  return false;
}

/**
 * Spawn was called but its tool result has not been committed to the transcript
 * yet — the brief streaming gap before history commits.
 *
 * IMPORTANT: a spawn whose result HAS landed (even a fire-and-forget `mode:run`
 * `{status:'accepted'}` with no `childSessionKey`, or a timed-out child) is NOT
 * unresolved. Such children are tracked via the gateway's processing keys, never
 * via this transcript signal. Treating an unbindable-but-committed spawn as
 * "unresolved" would strand the parent turn in "thinking" forever, hiding the
 * final reply until the user manually aborts.
 */
export function hasUnresolvedSpawnDelegation(messages: readonly RawMessage[]): boolean {
  const completed = collectCompletedSubagentSessionKeys([...messages]);
  const bindings = collectChildDelegationBindings([...messages], completed);
  const boundToolIds = new Set(
    bindings.map((binding) => binding.spawnToolCallId).filter((id): id is string => Boolean(id)),
  );
  const boundMessageIndexes = new Set(bindings.map((binding) => binding.spawnMessageIndex));

  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (!message || message.role !== 'assistant') continue;
    for (const tool of extractToolUse(message)) {
      if (!/sessions_spawn/i.test(tool.name)) continue;
      const toolId = tool.id || null;
      if (toolId && boundToolIds.has(toolId)) continue;
      if (!toolId && boundMessageIndexes.has(i)) continue;
      if (spawnResultCommitted(messages, i, toolId)) continue;
      return true;
    }
  }
  return false;
}

/** Parent interim "waiting on sub-agent" reply — not the deliverable announce wrap-up. */
export function isInterimSubagentWaitAssistantReply(message: RawMessage): boolean {
  if (message.role !== 'assistant') return false;
  const text = extractText(message).trim();
  if (!text) return false;
  if (shouldSilentlyFinalizeRunOnAssistantFinal(message)) return false;

  const normalized = text.replace(/\s+/g, ' ');
  // A deliverable can mention PPT/PPTX files and ordinary waiting (for example,
  // a printer queue timeout) without involving a delegated child. Require an
  // actual orchestration signal instead of treating the document type itself
  // as subagent context.
  const hasSubagentContext = /(?:sub-?agent|子\s*(?:agent|任务|智能体|代理)|分支|并行|spawn|delegate|瀛愪唬鐞唡瀛愭櫤鑳戒綋)/i.test(normalized);
  const hasBroadInterimSignal = /(?:预计|等待|几分钟|稍等|完成后.{0,12}通知|已(?:启动|交给)|正在.{0,12}(?:构建|生成)|in progress|waiting|will notify|minutes?)/i.test(normalized);
  const hasPhaseWaitSignal = /(?:continue\s+waiting|waiting\s+(?:for\s+)?Phase|Phase\s*\d+.*(?:completed|完成).*(?:waiting|等待|继续))/i.test(normalized);
  if (!hasSubagentContext && hasBroadInterimSignal && !hasPhaseWaitSignal) return false;
  if (/(?:all|both).{0,24}(?:sub-?agents?|children).{0,40}(?:returned|completed).{0,80}(?:summary|analysis|final)/i.test(normalized)) return false;
  if (/(?:两个|所有).{0,24}(?:子\s*agent|子任务|子智能体).{0,40}(?:都?已?(?:返回|完成)|返回|完成).{0,80}(?:汇总|分析|综合|结论)/i.test(normalized)) return false;

  // Partial multi-phase progress: one slice done but explicitly waiting for another.
  if (/(?:继续等待|continue\s+waiting|waiting\s+(?:for\s+)?Phase|等待\s*Phase)/i.test(text)) return true;
  if (/(?:已完成|完成了|also completed|completed).{0,48}(?:继续|等待|waiting)/i.test(text)) return true;
  if (/(?:Phase\s*\d+).{0,40}(?:完成|completed).{0,48}(?:继续|等待|waiting)/i.test(text)) return true;

  if (/(?:稍等|等一下|启动了一个子任务)/i.test(text)) return true;
  if (/(?:预计|等待|几分钟后|完成后.{0,12}通知|已启动|已交给|正在.{0,12}(?:构建|生成)|sub-?agent|子代理|子智能体)/i.test(text)) {
    return true;
  }

  // Deliverable finals often include ✅ / slide counts — but not when still waiting.
  if (/(?:已生成|生成完毕|✅|saved|slides?:\s*\d+|共\s*\d+\s*页)/i.test(text)) return false;

  return false;
}

export function isVisibleWrapUpAssistantReply(
  message: RawMessage,
  scopeMessages?: readonly RawMessage[],
): boolean {
  if (message.role !== 'assistant') return false;
  if (!extractText(message).trim()) return false;
  if (shouldSilentlyFinalizeRunOnAssistantFinal(message)) return false;
  if (isInterimSubagentWaitAssistantReply(message)) return false;
  if (extractToolUse(message).some((tool) => /sessions_(spawn|yield)/i.test(tool.name))) return false;
  if (isRunTerminalAssistantMessage(message)) return true;
  if (scopeMessages) {
    const concluding = findConcludingAssistantReply(scopeMessages);
    return concluding != null && concluding === message;
  }
  return false;
}

/**
 * Infer child session keys settled from transcript alone (no runtime announce event).
 * Announce wrap-ups never write `[Internal task completion event]` to the parent.
 */
export function inferTranscriptSettledChildSessionKeys(messages: RawMessage[]): Set<string> {
  const keys = new Set<string>();
  const baseCompleted = collectCompletedSubagentSessionKeys(messages);
  const bindings = collectChildDelegationBindings(messages, baseCompleted);
  if (bindings.length === 0) return keys;

  const userIdx = findLatestVisibleUserIndex(messages);
  const scope = userIdx >= 0 ? messages.slice(userIdx + 1) : messages;
  const firstSpawnIdx = scope.findIndex((message) =>
    message.role === 'assistant'
    && extractToolUse(message).some((tool) => /sessions_spawn/i.test(tool.name)),
  );
  if (firstSpawnIdx < 0) return keys;

  const hasWrapUp = scope.some((message, index) =>
    index > firstSpawnIdx && isVisibleWrapUpAssistantReply(message, scope),
  );
  if (!hasWrapUp) return keys;

  for (const binding of bindings) {
    if (!binding.completed) keys.add(binding.childSessionKey);
  }
  return keys;
}

export function resolveCompletedChildSessionKeys(
  messages: RawMessage[],
  extraKeys?: readonly string[],
): Set<string> {
  return new Set([
    ...collectCompletedSubagentSessionKeys(messages),
    ...inferTranscriptSettledChildSessionKeys(messages),
    ...(extraKeys ?? []),
  ]);
}

/** Gateway-only idle check for parent session + spawned children (ignores stale backend snapshots). */
export function isGatewayIdleForSpawnedChildren(
  sessionKey: string,
  messages: RawMessage[],
  processingSessionKeys: readonly string[],
  extraCompletedChildSessionKeys?: ReadonlySet<string> | readonly string[],
): boolean {
  const processing = new Set(processingSessionKeys);
  if (processing.has(sessionKey)) return false;
  const completed = new Set([
    ...collectCompletedSubagentSessionKeys(messages),
    ...(extraCompletedChildSessionKeys instanceof Set
      ? extraCompletedChildSessionKeys
      : extraCompletedChildSessionKeys ?? []),
  ]);
  const bindings = collectChildDelegationBindings(messages, completed);
  return !bindings.some((binding) =>
    !binding.completed && processing.has(binding.childSessionKey),
  );
}

/** Drop stale child processing keys once transcript/announce marks them complete. */
export function pruneSettledChildProcessingKeys(
  messages: RawMessage[],
  processingSessionKeys: readonly string[],
  extraCompletedChildSessionKeys?: readonly string[],
): string[] {
  const completed = new Set([
    ...collectCompletedSubagentSessionKeys(messages),
    ...(extraCompletedChildSessionKeys ?? []),
  ]);
  const bindings = collectChildDelegationBindings(messages, completed);
  const settledChildKeys = new Set(
    bindings.filter((binding) => binding.completed).map((binding) => binding.childSessionKey),
  );
  if (settledChildKeys.size === 0) return [...processingSessionKeys];
  return processingSessionKeys.filter((key) => !settledChildKeys.has(key));
}

/** True while any spawned child is still in flight on the gateway. */
export function isWaitingOnSubagentDelegation(
  messages: RawMessage[],
  processingSessionKeys: readonly string[] = [],
): boolean {
  const completed = collectCompletedSubagentSessionKeys(messages);
  const bindings = collectChildDelegationBindings(messages, completed);
  if (bindings.length === 0) return false;
  return hasActiveChildDelegations(bindings, processingSessionKeys);
}

/**
 * Parent turn must stay open: pending child in transcript, gateway processing,
 * or a sessions_spawn still visible in the live stream before history commits.
 */
export function hasInFlightSubagentSignals(
  messages: RawMessage[],
  options?: {
    streamingMessage?: unknown | null;
    processingSessionKeys?: readonly string[];
  },
): boolean {
  const processingSessionKeys = options?.processingSessionKeys ?? [];
  if (hasUnresolvedSpawnDelegation(messages)) return true;
  if (isWaitingOnSubagentDelegation(messages, processingSessionKeys)) return true;

  const completed = collectCompletedSubagentSessionKeys(messages);
  if (hasPendingChildDelegation(messages, completed, processingSessionKeys)) return true;

  if (options?.streamingMessage && typeof options.streamingMessage === 'object') {
    const tools = extractToolUse(options.streamingMessage as RawMessage);
    if (tools.some((tool) => /sessions_spawn/i.test(tool.name))) return true;
  }

  return false;
}

/** All spawn → child-session bindings in transcript order. */
export function collectChildDelegationBindings(
  messages: RawMessage[],
  completedChildSessionKeys: ReadonlySet<string>,
): ChildDelegationBinding[] {
  const bindings: ChildDelegationBinding[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (!message || message.role !== 'assistant') continue;
    for (const tool of extractToolUse(message)) {
      if (!/sessions_spawn/i.test(tool.name)) continue;
      const input = tool.input && typeof tool.input === 'object'
        ? tool.input as Record<string, unknown>
        : null;
      const label = typeof input?.label === 'string'
        ? input.label
        : typeof input?.taskName === 'string'
          ? input.taskName
          : null;

      let childSessionKey: string | null = null;
      let runId: string | null = null;
      for (let j = i + 1; j < messages.length; j += 1) {
        const candidate = messages[j];
        if (!isToolResultMessage(candidate)) continue;
        if (tool.id && candidate.toolCallId && candidate.toolCallId !== tool.id) continue;
        const parsed = tryParseJsonObject(extractText(candidate));
        if (!parsed) continue;
        if (typeof parsed.childSessionKey === 'string') childSessionKey = parsed.childSessionKey;
        if (typeof parsed.runId === 'string') runId = parsed.runId;
        if (childSessionKey) break;
      }
      if (!childSessionKey) continue;

      bindings.push({
        childSessionKey,
        spawnToolCallId: tool.id || null,
        label,
        spawnMessageIndex: i,
        completed: completedChildSessionKeys.has(childSessionKey),
        runId,
      });
    }
  }
  return bindings;
}

export function hasPendingChildDelegation(
  messages: RawMessage[],
  completedChildSessionKeys: ReadonlySet<string>,
  processingSessionKeys: readonly string[] = [],
): boolean {
  const bindings = collectChildDelegationBindings(messages, completedChildSessionKeys);
  return hasActiveChildDelegations(bindings, processingSessionKeys);
}

export function collectPendingChildDelegationBindings(
  messages: RawMessage[],
): ChildDelegationBinding[] {
  const completed = collectCompletedSubagentSessionKeys(messages);
  return collectChildDelegationBindings(messages, completed)
    .filter((binding) => !binding.completed);
}

/**
 * Detect a spawned subagent that is still running (spawn accepted, no completion
 * event in history yet). Used to poll child transcripts and surface progress
 * while the parent run is waiting on the delegate.
 */
export function findInFlightChildDelegation(
  messages: RawMessage[],
  completedChildSessionKeys: ReadonlySet<string>,
  processingSessionKeys: readonly string[] = [],
): InFlightChildDelegation | null {
  const bindings = collectChildDelegationBindings(messages, completedChildSessionKeys);
  const processing = new Set(processingSessionKeys);
  for (let i = bindings.length - 1; i >= 0; i -= 1) {
    const binding = bindings[i]!;
    if (isChildDelegationStillActive(binding, processing)) {
      return {
        label: binding.label,
        childSessionKey: binding.childSessionKey,
        runId: binding.runId,
      };
    }
  }
  return null;
}

/** Summarize the latest child transcript activity for status banners. */
export function summarizeChildRunActivity(childMessages: RawMessage[]): string | null {
  if (childMessages.length === 0) return '子 Agent 已启动，等待首个工具事件';

  for (let i = childMessages.length - 1; i >= 0; i -= 1) {
    const message = childMessages[i];
    if (!message || message.role !== 'assistant') continue;
    const tools = extractToolUse(message);
    if (tools.length > 0) {
      const lastTool = tools[tools.length - 1]!;
      return `子 Agent 正在执行：${lastTool.name}`;
    }
    const text = extractText(message).replace(/\s+/g, ' ').trim();
    if (text) return `子 Agent：${text.slice(0, 96)}${text.length > 96 ? '…' : ''}`;
  }

  return null;
}

function segmentHasSpawnSignal(
  segmentMessages: readonly RawMessage[],
  streamingMessage: unknown | null,
  streamingTools: ReadonlyArray<{ name: string }>,
): boolean {
  if (streamingTools.some((tool) => /sessions_spawn/i.test(tool.name))) return true;
  if (streamingMessage && typeof streamingMessage === 'object') {
    const tools = extractToolUse(streamingMessage as RawMessage);
    if (tools.some((tool) => /sessions_spawn/i.test(tool.name))) return true;
  }
  return segmentMessages.some((message) => (
    message.role === 'assistant'
    && extractToolUse(message).some((tool) => /sessions_spawn/i.test(tool.name))
  ));
}

function parseSpawnLabelFromToolInput(input: Record<string, unknown> | null): string | null {
  if (!input) return null;
  if (typeof input.taskName === 'string' && input.taskName.trim()) return input.taskName.trim();
  if (typeof input.label === 'string' && input.label.trim()) return input.label.trim();
  return null;
}

/**
 * Merge transcript bindings with live stream signals so execution-graph child
 * branches appear as soon as spawn is accepted, before history reload commits.
 */
export function mergeDelegationBindingsWithLiveStream(
  transcriptBindings: ChildDelegationBinding[],
  segmentMessages: readonly RawMessage[],
  streamingMessage: unknown | null,
  streamingTools: ReadonlyArray<{ name: string; status?: string; summary?: string; toolCallId?: string; id?: string }>,
  completedChildSessionKeys: ReadonlySet<string>,
  processingSessionKeys: readonly string[] = [],
): ChildDelegationBinding[] {
  const bindings = [...transcriptBindings];
  const boundToolIds = new Set(
    bindings.map((binding) => binding.spawnToolCallId).filter((id): id is string => Boolean(id)),
  );
  const boundChildKeys = new Set(bindings.map((binding) => binding.childSessionKey));

  const addBinding = (binding: ChildDelegationBinding): void => {
    if (boundChildKeys.has(binding.childSessionKey)) return;
    bindings.push(binding);
    if (binding.spawnToolCallId) boundToolIds.add(binding.spawnToolCallId);
    boundChildKeys.add(binding.childSessionKey);
  };

  for (const tool of streamingTools) {
    if (!/sessions_spawn/i.test(tool.name)) continue;
    const toolId = tool.toolCallId || tool.id || null;
    if (toolId && boundToolIds.has(toolId)) continue;
    const parsed = tryParseJsonObject(tool.summary);
    if (parsed && typeof parsed.childSessionKey === 'string') {
      addBinding({
        childSessionKey: parsed.childSessionKey,
        spawnToolCallId: toolId,
        label: typeof parsed.taskName === 'string' ? parsed.taskName : null,
        spawnMessageIndex: segmentMessages.length,
        completed: completedChildSessionKeys.has(parsed.childSessionKey),
        runId: typeof parsed.runId === 'string' ? parsed.runId : null,
      });
    }
  }

  if (streamingMessage && typeof streamingMessage === 'object') {
    const streamMsg = streamingMessage as RawMessage;
    for (const tool of extractToolUse(streamMsg)) {
      if (!/sessions_spawn/i.test(tool.name)) continue;
      const toolId = tool.id || null;
      if (toolId && boundToolIds.has(toolId)) continue;
      const input = tool.input && typeof tool.input === 'object'
        ? tool.input as Record<string, unknown>
        : null;
      const label = parseSpawnLabelFromToolInput(input);
      const processingChildren = processingSessionKeys.filter((key) => /:subagent:/i.test(key));
      for (const childSessionKey of processingChildren) {
        if (boundChildKeys.has(childSessionKey)) continue;
        addBinding({
          childSessionKey,
          spawnToolCallId: toolId,
          label,
          spawnMessageIndex: segmentMessages.length,
          completed: completedChildSessionKeys.has(childSessionKey),
          runId: null,
        });
        break;
      }
    }
  }

  if (segmentHasSpawnSignal(segmentMessages, streamingMessage, streamingTools)) {
    for (const childSessionKey of processingSessionKeys) {
      if (!/:subagent:/i.test(childSessionKey) || boundChildKeys.has(childSessionKey)) continue;
      addBinding({
        childSessionKey,
        spawnToolCallId: null,
        label: null,
        spawnMessageIndex: segmentMessages.length,
        completed: completedChildSessionKeys.has(childSessionKey),
        runId: null,
      });
    }
  }

  return bindings;
}
