/**
 * Parse OpenClaw session transcript JSONL for skill `read` invocations
 * (paths ending in `/skills/<slug>/SKILL.md`).
 *
 * Shared between renderer extractors and main-process cron reporting.
 */

const SKILL_MD_PATH_PATTERN = /[/\\]skills[/\\]([^/\\]+)[/\\]SKILL\.md$/i;

export function extractSkillSlugFromSkillMdPath(path: string | undefined | null): string | null {
  const trimmed = (path ?? '').trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/^~(?=$|[/\\])/, '').replace(/\\/g, '/');
  const match = normalized.match(SKILL_MD_PATH_PATTERN);
  return match?.[1]?.trim() || null;
}

export function extractSkillInvocationFromToolCall(
  name: string | undefined,
  input?: Record<string, unknown>,
): { skillId: string; skillPath: string } | null {
  const toolName = (name ?? '').trim().toLowerCase();
  if (toolName !== 'read') return null;
  const path = typeof input?.path === 'string' ? input.path : '';
  const skillId = extractSkillSlugFromSkillMdPath(path);
  if (!skillId) return null;
  return { skillId, skillPath: path };
}

export type TranscriptSkillRead = {
  skillId: string;
  skillPath: string;
  invokeTimeMs: number;
  toolCallId: string;
};

function readToolCallInput(block: Record<string, unknown>): Record<string, unknown> | undefined {
  const raw = block.input ?? block.arguments;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function parseTranscriptMessageTimestamp(message: unknown, entryTimestamp?: unknown): number | undefined {
  if (message && typeof message === 'object') {
    const timestamp = (message as { timestamp?: unknown }).timestamp;
    if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
      return timestamp < 1e12 ? timestamp * 1000 : timestamp;
    }
    if (typeof timestamp === 'string' && timestamp.trim()) {
      const parsed = Date.parse(timestamp);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  if (typeof entryTimestamp === 'string' && entryTimestamp.trim()) {
    const parsed = Date.parse(entryTimestamp.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function extractReadsFromAssistantMessage(
  message: unknown,
  invokeTimeMs: number,
): TranscriptSkillRead[] {
  if (!message || typeof message !== 'object') return [];
  const record = message as Record<string, unknown>;
  const reads: TranscriptSkillRead[] = [];

  const content = record.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const raw = block as Record<string, unknown>;
      const type = String(raw.type ?? '').toLowerCase();
      if (type !== 'tool_use' && type !== 'toolcall') continue;
      const name = typeof raw.name === 'string' ? raw.name : '';
      const invocation = extractSkillInvocationFromToolCall(name, readToolCallInput(raw));
      if (!invocation) continue;
      const id = typeof raw.id === 'string' && raw.id.trim()
        ? raw.id.trim()
        : `${invocation.skillId}-${reads.length}`;
      reads.push({
        skillId: invocation.skillId,
        skillPath: invocation.skillPath,
        invokeTimeMs,
        toolCallId: id,
      });
    }
  }

  const toolCallsRaw = record.tool_calls ?? record.toolCalls;
  if (Array.isArray(toolCallsRaw)) {
    for (const tc of toolCallsRaw) {
      if (!tc || typeof tc !== 'object') continue;
      const raw = tc as Record<string, unknown>;
      const fn = (raw.function as Record<string, unknown> | undefined) ?? raw;
      const nameUnknown = fn?.name ?? raw.name;
      const name = typeof nameUnknown === 'string' ? nameUnknown : '';
      const invocation = extractSkillInvocationFromToolCall(name, readToolCallInput(fn ?? raw));
      if (!invocation) continue;
      const idUnknown = raw.id;
      const id = typeof idUnknown === 'string' && idUnknown.trim()
        ? idUnknown.trim()
        : `${invocation.skillId}-tc-${reads.length}`;
      reads.push({
        skillId: invocation.skillId,
        skillPath: invocation.skillPath,
        invokeTimeMs,
        toolCallId: id,
      });
    }
  }

  return reads;
}

/** Collect unique skill reads from transcript lines at/after `afterMs`. */
export function parseSkillReadsFromTranscript(
  content: string,
  options?: { afterMs?: number },
): TranscriptSkillRead[] {
  const afterMs = options?.afterMs;
  const reads = new Map<string, TranscriptSkillRead>();

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as {
        type?: string;
        timestamp?: string;
        message?: { role?: unknown };
      };
      if (entry.type !== 'message') continue;
      const message = entry.message;
      if (!message || typeof message !== 'object') continue;
      const role = String((message as { role?: unknown }).role ?? '').toLowerCase();
      if (role !== 'assistant') continue;

      const invokeTimeMs = parseTranscriptMessageTimestamp(message, entry.timestamp) ?? Date.now();
      if (afterMs != null && invokeTimeMs < afterMs - 2_000) continue;

      for (const read of extractReadsFromAssistantMessage(message, invokeTimeMs)) {
        const key = read.skillId.trim().toLowerCase();
        if (!key || reads.has(key)) continue;
        reads.set(key, read);
      }
    } catch {
      // Ignore malformed transcript lines.
    }
  }

  return [...reads.values()];
}
