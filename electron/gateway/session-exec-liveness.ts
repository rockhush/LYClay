import { open, readFile, stat } from 'fs/promises';
import path from 'path';
import { homedir } from 'os';

type SessionStoreEntry = {
  sessionFile?: unknown;
};

type TranscriptMessage = {
  role?: unknown;
  toolName?: unknown;
  toolCallId?: unknown;
  details?: { status?: unknown };
  content?: unknown;
};

type TranscriptLine = {
  type?: unknown;
  message?: TranscriptMessage;
};

const ACTIVE_EXEC_STATUSES = new Set(['running', 'pending']);
const TAIL_READ_BYTES = 256 * 1024;

function parseAgentId(sessionKey: string): string | null {
  if (!sessionKey.startsWith('agent:')) return null;
  return sessionKey.split(':')[1]?.trim() || null;
}

function resolveSessionTranscriptPath(
  sessionsDir: string,
  sessionKey: string,
  entry: SessionStoreEntry,
): string | null {
  const rawSessionFile = typeof entry.sessionFile === 'string' ? entry.sessionFile.trim() : '';
  if (rawSessionFile) {
    return path.isAbsolute(rawSessionFile)
      ? rawSessionFile
      : path.join(sessionsDir, rawSessionFile);
  }

  const sessionSegment = sessionKey.split(':').slice(2).join(':');
  if (!sessionSegment || sessionSegment === 'main') return null;
  return path.join(sessionsDir, `${sessionSegment}.jsonl`);
}

function isExecToolName(toolName: unknown): boolean {
  const normalized = String(toolName ?? '').toLowerCase();
  return normalized === 'exec' || normalized === 'process';
}

function normalizeExecStatus(details: TranscriptMessage['details'], content: unknown): string {
  const fromDetails = String(details?.status ?? '').toLowerCase();
  if (fromDetails) return fromDetails;

  const text = Array.isArray(content)
    ? content.map((block) => {
      if (block && typeof block === 'object' && 'text' in block) {
        return String((block as { text?: unknown }).text ?? '');
      }
      return '';
    }).join('\n')
    : String(content ?? '');

  if (/command still running/i.test(text) || /process still running/i.test(text)) {
    return 'running';
  }
  return '';
}

export function hasRunningExecInLines(lines: TranscriptLine[]): boolean {
  const statusByToolCall = new Map<string, string>();

  for (const line of lines) {
    if (line.type !== 'message') continue;
    const message = line.message;
    if (!message || !isExecToolName(message.toolName)) continue;

    const toolCallId = String(message.toolCallId ?? '').trim();
    const status = normalizeExecStatus(message.details, message.content);
    if (!toolCallId) {
      if (ACTIVE_EXEC_STATUSES.has(status)) return true;
      continue;
    }
    statusByToolCall.set(toolCallId, status);
  }

  for (const status of statusByToolCall.values()) {
    if (ACTIVE_EXEC_STATUSES.has(status)) return true;
  }
  return false;
}

async function readTranscriptTail(filePath: string): Promise<string> {
  const fileStat = await stat(filePath);
  const start = Math.max(0, fileStat.size - TAIL_READ_BYTES);
  const length = fileStat.size - start;
  if (length <= 0) return '';

  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * Detect in-flight exec/process tool sessions from the session transcript tail.
 * OpenClaw writes toolResult.details.status=running while a shell command is active.
 */
export async function hasActiveExecInSessionTranscript(params: {
  sessionKey: string;
  openclawDir?: string;
}): Promise<boolean> {
  const sessionKey = params.sessionKey.trim();
  const agentId = parseAgentId(sessionKey);
  if (!agentId) return false;

  const openclawDir = params.openclawDir ?? path.join(homedir(), '.openclaw');
  const sessionsDir = path.join(openclawDir, 'agents', agentId, 'sessions');
  const sessionsJsonPath = path.join(sessionsDir, 'sessions.json');

  let sessionsJson: Record<string, SessionStoreEntry>;
  try {
    sessionsJson = JSON.parse(await readFile(sessionsJsonPath, 'utf8')) as Record<string, SessionStoreEntry>;
  } catch {
    return false;
  }

  const entry = sessionsJson[sessionKey];
  if (!entry) return false;

  const transcriptPath = resolveSessionTranscriptPath(sessionsDir, sessionKey, entry);
  if (!transcriptPath) return false;

  let tail: string;
  try {
    tail = await readTranscriptTail(transcriptPath);
  } catch {
    return false;
  }

  if (!tail.trim()) return false;

  const lines: TranscriptLine[] = [];
  for (const rawLine of tail.split('\n')) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    try {
      lines.push(JSON.parse(trimmed) as TranscriptLine);
    } catch {
      // Skip partial tail line from byte-boundary reads.
    }
  }

  return hasRunningExecInLines(lines);
}
