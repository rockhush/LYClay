/**
 * Pure helpers that read OpenClaw runtime messages and extract the fields
 * needed by the management/claw/report uploader (token consume + skill invoke).
 *
 * Kept intentionally side-effect-free so the same logic can be reused across
 * the runtime event handler, replay tools, and unit tests without dragging
 * in zustand / IPC dependencies.
 */

import type { RawMessage, ContentBlock } from './types';

export interface SkillMentionLike {
  /** Stable identifier sent to the report backend. */
  id: string;
  /** Display name as it appears in `@<name>` mentions. */
  name: string;
}

/**
 * Detect every `@<skillName>` mention inside a piece of user-authored text
 * and return the matching skill ids. Used by `ChatInput.handleSend` to count
 * skill invocations for the slash-search and hand-typed mention paths where
 * `skillAttachments` is empty (those paths only rewrite the input text, not
 * the chip state).
 *
 * Skills are scanned longest-name-first so `@market-analysis-ch` never
 * collapses into a `@market` prefix when both happen to coexist. Matches are
 * case-insensitive and require a non-(word|hyphen) boundary after the name
 * so `@cn-translate-2` doesn't accidentally trigger `cn-translate`.
 */
export function detectMentionedSkillIds(text: string, skills: readonly SkillMentionLike[]): string[] {
  if (!text || skills.length === 0) return [];
  const ordered = [...skills].sort((a, b) => b.name.length - a.name.length);
  const seen = new Set<string>();
  for (const skill of ordered) {
    const id = (skill?.id || '').trim();
    const name = (skill?.name || '').trim();
    if (!id || !name) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`@${escaped}(?![\\w-])`, 'i');
    if (re.test(text)) seen.add(id);
  }
  return [...seen];
}

interface MaybeUsage {
  total_tokens?: unknown;
  totalTokens?: unknown;
  total?: unknown;
  input_tokens?: unknown;
  inputTokens?: unknown;
  prompt_tokens?: unknown;
  promptTokens?: unknown;
  output_tokens?: unknown;
  outputTokens?: unknown;
  completion_tokens?: unknown;
  completionTokens?: unknown;
}

function asNonNegativeNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

function firstNumber(usage: MaybeUsage, keys: Array<keyof MaybeUsage>): number {
  for (const k of keys) {
    const n = asNonNegativeNumber(usage[k]);
    if (n > 0) return n;
  }
  return 0;
}

/**
 * Compute the "consume" field from a RawMessage's `usage` payload.
 * Prefers `total_tokens`; falls back to input+output sum so we still
 * record something for providers that omit the explicit total.
 */
export function extractTotalTokensFromUsage(usage: unknown): number {
  if (!usage || typeof usage !== 'object') return 0;
  const u = usage as MaybeUsage;
  const total = firstNumber(u, ['total_tokens', 'totalTokens', 'total']);
  if (total > 0) return total;
  const input = firstNumber(u, ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens']);
  const output = firstNumber(u, ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens']);
  return input + output;
}

export interface TokenConsumeExtraction {
  model: string;
  consume: number;
}

/**
 * Pull out the (model, consume) pair from a finalized assistant message, or
 * null if the message has no usage payload / no positive token count.
 */
export function extractTokenConsumeFromAssistantMessage(message: RawMessage | undefined | null): TokenConsumeExtraction | null {
  if (!message) return null;
  const role = String(message.role || '').toLowerCase();
  if (role !== 'assistant') return null;

  const raw = message as unknown as Record<string, unknown>;
  const usage = raw.usage;
  const consume = extractTotalTokensFromUsage(usage);
  if (consume <= 0) return null;

  const model = (raw.model as string)
    || (raw.modelRef as string)
    || '';
  const trimmedModel = model.trim();
  if (!trimmedModel) return null;
  return { model: trimmedModel, consume };
}

/**
 * Iterate every tool/skill invocation referenced by a message and return
 * `(skillId, toolCallId)` pairs ready for the management/claw/report queue.
 *
 * OpenClaw normalises across two upstream formats and we must support both,
 * because the streaming `final` event passes the runtime's raw payload through
 * to the renderer:
 *
 *   1. Anthropic-style — `message.content[]` with `type: 'tool_use'`
 *      (or `'toolCall'`) blocks where the skill name is `block.name` and the
 *      stable id is `block.id`.
 *   2. OpenAI-style — top-level `message.tool_calls[]` (or `toolCalls[]`)
 *      where each entry exposes the function name as either `tc.name` or
 *      `tc.function.name`, and `tc.id` is the call id.
 *
 * Tool name == skill id from the runtime perspective (skills register
 * themselves as tools via the OpenClaw plugin SDK).
 */
export function extractInvokedSkillIds(message: RawMessage | undefined | null): Array<{ skillId: string; toolCallId: string }> {
  if (!message) return [];
  const out: Array<{ skillId: string; toolCallId: string }> = [];

  // Format 1: Anthropic content blocks.
  const content = message.content;
  if (Array.isArray(content)) {
    for (const block of content as ContentBlock[]) {
      if (block.type !== 'tool_use' && block.type !== 'toolCall') continue;
      const name = (block as unknown as { name?: unknown }).name;
      if (typeof name !== 'string' || name.trim() === '') continue;
      const id = (block as unknown as { id?: unknown }).id;
      out.push({
        skillId: name.trim(),
        toolCallId: typeof id === 'string' && id.trim() !== '' ? id.trim() : `${name}-${out.length}`,
      });
    }
  }

  // Format 2: OpenAI tool_calls / toolCalls top-level array.
  const msgAny = message as unknown as Record<string, unknown>;
  const toolCallsRaw = msgAny.tool_calls ?? msgAny.toolCalls;
  if (Array.isArray(toolCallsRaw)) {
    for (const tc of toolCallsRaw as Array<Record<string, unknown>>) {
      const fn = (tc.function as Record<string, unknown> | undefined) ?? tc;
      const nameUnknown = fn?.name ?? (tc as Record<string, unknown>).name;
      const name = typeof nameUnknown === 'string' ? nameUnknown.trim() : '';
      if (!name) continue;
      const idUnknown = (tc as Record<string, unknown>).id;
      const id = typeof idUnknown === 'string' && idUnknown.trim() !== ''
        ? idUnknown.trim()
        : `${name}-tc-${out.length}`;
      out.push({ skillId: name, toolCallId: id });
    }
  }

  return out;
}
