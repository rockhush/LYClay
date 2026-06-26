import { extractText, extractToolUse } from '@/pages/Chat/message-utils';
import type { RawMessage } from '@/stores/chat';
import { hasActiveChildDelegations } from '@/lib/subagent-delegation-watch';

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

export function collectCompletedSubagentSessionKeys(messages: RawMessage[]): Set<string> {
  const keys = new Set<string>();
  for (const message of messages) {
    const info = parseSubagentCompletionInfo(message);
    if (info) keys.add(info.sessionKey);
  }
  return keys;
}

/** True while any spawned child is still in flight (transcript and/or gateway). */
export function isWaitingOnSubagentDelegation(
  messages: RawMessage[],
  processingSessionKeys: readonly string[] = [],
): boolean {
  const completed = collectCompletedSubagentSessionKeys(messages);
  const bindings = collectChildDelegationBindings(messages, completed);
  if (bindings.length === 0) return false;
  return hasActiveChildDelegations(bindings, processingSessionKeys);
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
): boolean {
  return collectChildDelegationBindings(messages, completedChildSessionKeys)
    .some((binding) => !binding.completed);
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
    if (!binding.completed || processing.has(binding.childSessionKey)) {
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
