import { readFile } from 'fs/promises';

type TranscriptLine = {
  type?: string;
  customType?: string;
  message?: {
    role?: string;
    content?: unknown;
    idempotencyKey?: string;
  };
};

function parseTranscriptLines(raw: string): TranscriptLine[] {
  const entries: TranscriptLine[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as TranscriptLine;
      if (parsed && typeof parsed === 'object') entries.push(parsed);
    } catch {
      // ignore malformed lines
    }
  }
  return entries;
}

function contentBlocks(content: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) return [];
  return content.filter((block): block is Record<string, unknown> => Boolean(block && typeof block === 'object'));
}

function messageHasToolName(message: TranscriptLine['message'], toolName: RegExp): boolean {
  if (!message) return false;
  for (const block of contentBlocks(message.content)) {
    const type = typeof block.type === 'string' ? block.type : '';
    const name = typeof block.name === 'string' ? block.name : '';
    if ((type === 'toolCall' || type === 'tool_use') && toolName.test(name)) return true;
  }
  return false;
}

function messageMatchesRun(message: TranscriptLine['message'], runId: string): boolean {
  if (!message) return false;
  const key = message.idempotencyKey;
  if (typeof key === 'string' && (key === runId || key.startsWith(`${runId}:`))) return true;
  return false;
}

/**
 * True when the active user turn ended via sessions_yield (spawn delegated work, no user text).
 * Used to avoid treating intentional yield finals as empty-final failures.
 */
export function transcriptEntriesShowDelegationYield(
  entries: readonly TranscriptLine[],
  runId?: string | null,
): boolean {
  let turnStart = 0;
  if (runId) {
    const idx = entries.findIndex((entry) => entry.type === 'message' && messageMatchesRun(entry.message, runId));
    if (idx >= 0) turnStart = idx;
  }

  const turnEntries = entries.slice(turnStart);
  let sawSpawn = false;
  let sawYield = false;

  for (const entry of turnEntries) {
    if (entry.type === 'custom_message' && entry.customType === 'openclaw.sessions_yield') {
      sawYield = true;
    }
    if (entry.type === 'message' && entry.message?.role === 'assistant') {
      if (messageHasToolName(entry.message, /^sessions_spawn$/i)) sawSpawn = true;
      if (messageHasToolName(entry.message, /^sessions_yield$/i)) sawYield = true;
    }
  }

  return sawSpawn && sawYield;
}

export async function transcriptFileShowsDelegationYield(
  transcriptPath: string,
  runId?: string | null,
): Promise<boolean> {
  try {
    const raw = await readFile(transcriptPath, 'utf8');
    return transcriptEntriesShowDelegationYield(parseTranscriptLines(raw), runId);
  } catch {
    return false;
  }
}
