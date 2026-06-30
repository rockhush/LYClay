import { readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { redactStructuredSecrets } from '../security/secret-scanner';
import { sanitizeTranscriptMessageForDisplay } from '../utils/silent-reply-sanitize';
import type { CronRunLogEntry } from './cron-run-log';

export interface CronHistoryMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  isError?: boolean;
}

export type SessionFileInfo = { fileName?: string; resolvedPath?: string };

function normalizeTimestampMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function getMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (block && typeof block === 'object') {
          const text = (block as { text?: unknown }).text;
          return typeof text === 'string' ? text : '';
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function parseTranscriptMessageTimestamp(message: unknown): number | undefined {
  if (!message || typeof message !== 'object') return undefined;
  const record = message as { timestamp?: unknown };
  if (typeof record.timestamp !== 'number' || !Number.isFinite(record.timestamp)) {
    return undefined;
  }
  return record.timestamp < 1e12 ? record.timestamp * 1000 : record.timestamp;
}

function mergeTranscriptEntryTimestamp(message: unknown, entryTimestamp?: string): unknown {
  let ms = parseTranscriptMessageTimestamp(message);
  if (!ms && typeof entryTimestamp === 'string' && entryTimestamp.trim()) {
    const parsed = Date.parse(entryTimestamp.trim());
    if (Number.isFinite(parsed)) ms = parsed;
  }
  if (!ms) return message;

  const record: Record<string, unknown> = message && typeof message === 'object'
    ? { ...(message as Record<string, unknown>) }
    : { content: message };
  record.timestamp = ms / 1000;
  return record;
}

function toCronHistoryMessage(message: unknown, fallbackId: string): CronHistoryMessage | null {
  if (!message || typeof message !== 'object') return null;
  const record = message as {
    role?: unknown;
    content?: unknown;
    id?: unknown;
    isError?: unknown;
  };
  const role = typeof record.role === 'string' ? record.role.toLowerCase() : '';
  if (role !== 'user' && role !== 'assistant' && role !== 'system') return null;

  const content = getMessageText(record.content);
  if (!content.trim()) return null;

  const timestamp = parseTranscriptMessageTimestamp(message) ?? Date.now();
  const id = typeof record.id === 'string' && record.id.trim()
    ? record.id
    : `${fallbackId}-${role}-${timestamp}`;

  return {
    id,
    role: role as CronHistoryMessage['role'],
    content,
    timestamp,
    ...(record.isError ? { isError: true } : {}),
  };
}

function resolvePathFromFileInfo(info: SessionFileInfo | undefined, sessionsDir: string): string | null {
  if (!info) return null;
  if (info.resolvedPath) {
    return isAbsolute(info.resolvedPath)
      ? info.resolvedPath
      : join(sessionsDir, info.resolvedPath);
  }
  if (info.fileName) {
    const fileName = info.fileName.endsWith('.jsonl') ? info.fileName : `${info.fileName}.jsonl`;
    return join(sessionsDir, fileName);
  }
  return null;
}

export function resolveRunTranscriptPath(
  agentId: string,
  jobId: string,
  run: CronRunLogEntry,
  sessionsDir: string,
  filesBySessionKey: Map<string, SessionFileInfo>,
): string | null {
  const sessionKey = typeof run.sessionKey === 'string' ? run.sessionKey.trim() : '';
  const mainKey = `agent:${agentId}:cron:${jobId}`;
  if (sessionKey && sessionKey !== mainKey) {
    const fromKey = resolvePathFromFileInfo(filesBySessionKey.get(sessionKey), sessionsDir);
    if (fromKey) return fromKey;
  }

  const sessionId = typeof run.sessionId === 'string' ? run.sessionId.trim() : '';
  if (!sessionId) return null;

  const fromSessionId = join(
    sessionsDir,
    sessionId.endsWith('.jsonl') ? sessionId : `${sessionId}.jsonl`,
  );
  return fromSessionId;
}

export async function readTranscriptHistoryMessages(
  transcriptPath: string,
  idPrefix: string,
): Promise<CronHistoryMessage[]> {
  const raw = await readFile(transcriptPath, 'utf8').catch(() => '');
  if (!raw.trim()) return [];

  const messages: CronHistoryMessage[] = [];
  const lines = raw.split(/\r?\n/).filter(Boolean);
  lines.forEach((line, idx) => {
    try {
      const entry = JSON.parse(line) as { type?: string; timestamp?: string; message?: unknown };
      if (entry.type !== 'message' || !entry.message) return;
      const sanitized = sanitizeTranscriptMessageForDisplay(entry.message);
      const merged = mergeTranscriptEntryTimestamp(redactStructuredSecrets(sanitized), entry.timestamp);
      const parsed = toCronHistoryMessage(merged, `${idPrefix}-${idx}`);
      if (!parsed) return;
      if (parsed.role === 'system' && !parsed.isError) return;
      messages.push(parsed);
    } catch {
      // Ignore malformed transcript lines.
    }
  });
  return messages;
}

function formatDuration(durationMs: number | undefined): string | null {
  if (!durationMs || !Number.isFinite(durationMs)) return null;
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  if (durationMs < 10_000) return `${(durationMs / 1000).toFixed(1)}s`;
  return `${Math.round(durationMs / 1000)}s`;
}

function buildRunSummaryMessage(entry: CronRunLogEntry, index: number): CronHistoryMessage | null {
  const timestamp = normalizeTimestampMs(entry.ts) ?? normalizeTimestampMs(entry.runAtMs);
  if (!timestamp) return null;

  const status = typeof entry.status === 'string' ? entry.status.toLowerCase() : '';
  const summary = typeof entry.summary === 'string' ? entry.summary.trim() : '';
  const error = typeof entry.error === 'string' ? entry.error.trim() : '';
  let content = summary || error;

  if (!content) {
    content = status === 'error'
      ? 'Scheduled task failed.'
      : 'Scheduled task completed.';
  }

  if (status === 'error' && !content.toLowerCase().startsWith('run failed:')) {
    content = `Run failed: ${content}`;
  }

  const meta: string[] = [];
  const duration = formatDuration(entry.durationMs);
  if (duration) meta.push(`Duration: ${duration}`);
  if (entry.provider && entry.model) {
    meta.push(`Model: ${entry.provider}/${entry.model}`);
  } else if (entry.model) {
    meta.push(`Model: ${entry.model}`);
  }
  if (meta.length > 0) {
    content = `${content}\n\n${meta.join(' | ')}`;
  }

  return {
    id: `cron-run-${entry.sessionId ?? entry.ts ?? index}`,
    role: status === 'error' ? 'system' : 'assistant',
    content,
    timestamp,
    ...(status === 'error' ? { isError: true } : {}),
  };
}

function messageDedupeKey(message: CronHistoryMessage): string {
  return `${message.timestamp}|${message.role}|${message.content.slice(0, 240)}`;
}

function appendUniqueMessages(
  target: CronHistoryMessage[],
  incoming: CronHistoryMessage[],
  minTimestampMs?: number,
): void {
  const seen = new Set(target.map(messageDedupeKey));
  for (const message of incoming) {
    if (minTimestampMs != null && message.timestamp < minTimestampMs) continue;
    const key = messageDedupeKey(message);
    if (seen.has(key)) continue;
    seen.add(key);
    target.push(message);
  }
}

function getSessionEntryFileInfo(
  entry: Record<string, unknown>,
  options?: { preferId?: boolean },
): SessionFileInfo {
  let fileName = (entry.file ?? entry.fileName ?? entry.path) as string | undefined;
  const resolvedPath = entry.sessionFile as string | undefined;
  const uuidVal = (entry.id ?? entry.sessionId) as string | undefined;
  if (uuidVal && (options?.preferId || !fileName)) {
    fileName = uuidVal.endsWith('.jsonl') ? uuidVal : `${uuidVal}.jsonl`;
  }
  return { fileName, resolvedPath };
}

export async function buildSessionFileIndex(
  sessionsJsonPath: string,
): Promise<Map<string, SessionFileInfo>> {
  const filesBySessionKey = new Map<string, SessionFileInfo>();
  const raw = await readFile(sessionsJsonPath, 'utf8').catch(() => '');
  if (!raw.trim()) return filesBySessionKey;

  try {
    const sessionsJson = JSON.parse(raw) as Record<string, unknown>;
    if (Array.isArray(sessionsJson.sessions)) {
      for (const entry of sessionsJson.sessions as Array<Record<string, unknown>>) {
        const key = entry.key ?? entry.sessionKey;
        if (typeof key === 'string') {
          filesBySessionKey.set(key, getSessionEntryFileInfo(entry));
        }
      }
    }

    for (const [key, value] of Object.entries(sessionsJson)) {
      if (key === 'sessions') continue;
      if (typeof value === 'string') {
        filesBySessionKey.set(key, { fileName: value });
      } else if (typeof value === 'object' && value !== null) {
        filesBySessionKey.set(key, getSessionEntryFileInfo(value as Record<string, unknown>, { preferId: true }));
      }
    }
  } catch {
    return filesBySessionKey;
  }

  return filesBySessionKey;
}

export async function buildCronSessionHistoryMessages(params: {
  agentId: string;
  jobId: string;
  sessionKey: string;
  runs: CronRunLogEntry[];
  job?: {
    name?: string;
    payload?: { message?: string; text?: string };
    state?: { runningAtMs?: number };
  };
  sessionEntry?: { label?: string; updatedAt?: number };
  sessionsDir: string;
  filesBySessionKey: Map<string, SessionFileInfo>;
  limit?: number;
}): Promise<CronHistoryMessage[]> {
  const matchingRuns = params.runs
    .filter((entry) => {
      const parts = params.sessionKey.split(':');
      // scheduled-task: agent:agentId:scheduled-task:jobId:runSessionId
      if (parts.length >= 5 && parts[2] === 'scheduled-task') {
        const runSessionId = parts[4];
        if (!runSessionId) return true;
        return entry.sessionId === runSessionId
          || entry.sessionKey === params.sessionKey;
      }
      // cron-run: agent:agentId:cron-run:jobId:runSessionId
      if (parts.length >= 5 && parts[2] === 'cron-run') {
        const runSessionId = parts[4];
        if (!runSessionId) return true;
        return entry.sessionId === runSessionId
          || entry.sessionKey === params.sessionKey;
      }
      // cron legacy: agent:agentId:cron:jobId[:runSessionId]
      // or: agent:agentId:cron:jobId:run:runSessionId
      const runSessionId = parts.length === 5 ? parts[4] : undefined;
      const legacyRunSessionId = parts.length === 6 && parts[4] === 'run' ? parts[5] : undefined;
      const effectiveRunSessionId = runSessionId ?? legacyRunSessionId;
      if (!effectiveRunSessionId) return true;
      return entry.sessionId === effectiveRunSessionId || entry.sessionKey === params.sessionKey;
    })
    .sort((left, right) => {
      const leftTs = normalizeTimestampMs(left.ts) ?? normalizeTimestampMs(left.runAtMs) ?? 0;
      const rightTs = normalizeTimestampMs(right.ts) ?? normalizeTimestampMs(right.runAtMs) ?? 0;
      return leftTs - rightTs;
    });

  const messages: CronHistoryMessage[] = [];
  const prompt = params.job?.payload?.message || params.job?.payload?.text || '';
  const taskName = params.job?.name?.trim()
    || params.sessionEntry?.label?.replace(/^Cron:\s*/i, '').replace(/^\[cron:[^\]]+\]\s*/i, '').trim()
    || '';
  const firstRelevantTimestamp = matchingRuns.length > 0
    ? (normalizeTimestampMs(matchingRuns[0]?.runAtMs) ?? normalizeTimestampMs(matchingRuns[0]?.ts))
    : (normalizeTimestampMs(params.job?.state?.runningAtMs) ?? params.sessionEntry?.updatedAt);

  if (taskName || prompt) {
    const lines = [taskName ? `Scheduled task: ${taskName}` : 'Scheduled task'];
    if (prompt) lines.push(`Prompt: ${prompt}`);
    messages.push({
      id: `cron-meta-${params.jobId}`,
      role: 'system',
      content: lines.join('\n'),
      timestamp: Math.max(0, (firstRelevantTimestamp ?? Date.now()) - 1),
    });
  }

  const seenRunKeys = new Set<string>();
  for (let index = 0; index < matchingRuns.length; index += 1) {
    const run = matchingRuns[index]!;
    const runKey = run.sessionId
      ?? (typeof run.sessionKey === 'string' ? run.sessionKey : '')
      ?? String(normalizeTimestampMs(run.runAtMs) ?? normalizeTimestampMs(run.ts) ?? index);
    if (seenRunKeys.has(runKey)) continue;
    seenRunKeys.add(runKey);

    const transcriptPath = resolveRunTranscriptPath(
      params.agentId,
      params.jobId,
      run,
      params.sessionsDir,
      params.filesBySessionKey,
    );

    if (transcriptPath) {
      try {
        await stat(transcriptPath);
        const runMessages = await readTranscriptHistoryMessages(
          transcriptPath,
          `cron-run-${basename(transcriptPath, '.jsonl')}`,
        );
        if (runMessages.length > 0) {
          appendUniqueMessages(messages, runMessages);
          continue;
        }
      } catch {
        // Fall back to run-log summary below.
      }
    }

    const summary = buildRunSummaryMessage(run, index);
    if (summary) appendUniqueMessages(messages, [summary]);
  }

  const runPrefix = `agent:${params.agentId}:cron:${params.jobId}:run:`;
  const discoveredRunKeys = [...params.filesBySessionKey.keys()]
    .filter((key) => key.startsWith(runPrefix))
    .sort();
  for (const runSessionKey of discoveredRunKeys) {
    if (seenRunKeys.has(runSessionKey)) continue;
    const transcriptPath = resolvePathFromFileInfo(
      params.filesBySessionKey.get(runSessionKey),
      params.sessionsDir,
    );
    if (!transcriptPath) continue;
    try {
      await stat(transcriptPath);
      const runMessages = await readTranscriptHistoryMessages(
        transcriptPath,
        `cron-run-${basename(transcriptPath, '.jsonl')}`,
      );
      if (runMessages.length > 0) {
        seenRunKeys.add(runSessionKey);
        appendUniqueMessages(messages, runMessages);
      }
    } catch {
      // Ignore missing run transcripts.
    }
  }

  const mainTranscriptPath = resolvePathFromFileInfo(
    params.filesBySessionKey.get(params.sessionKey),
    params.sessionsDir,
  );
  if (mainTranscriptPath) {
    const latestMessages = await readTranscriptHistoryMessages(mainTranscriptPath, 'cron-main');
    const latestAggregatedTs = messages.reduce((max, message) => Math.max(max, message.timestamp), 0);
    appendUniqueMessages(messages, latestMessages, latestAggregatedTs > 0 ? latestAggregatedTs - 60_000 : undefined);
  }

  if (matchingRuns.length === 0) {
    const runningAt = normalizeTimestampMs(params.job?.state?.runningAtMs);
    if (runningAt) {
      messages.push({
        id: `cron-running-${params.jobId}`,
        role: 'system',
        content: 'This scheduled task is still running in OpenClaw, but no chat transcript is available yet.',
        timestamp: runningAt,
      });
    } else if (messages.length === 0) {
      messages.push({
        id: `cron-empty-${params.jobId}`,
        role: 'system',
        content: 'No chat transcript is available for this scheduled task yet.',
        timestamp: params.sessionEntry?.updatedAt ?? Date.now(),
      });
    }
  }

  messages.sort((left, right) => left.timestamp - right.timestamp);

  const limit = typeof params.limit === 'number' && Number.isFinite(params.limit)
    ? Math.max(1, Math.floor(params.limit))
    : messages.length;
  return messages.slice(-limit);
}
