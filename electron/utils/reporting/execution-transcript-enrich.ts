/**
 * Enrich queued execution records with token usage from OpenClaw session
 * transcripts — the same source that powers Models → Token 消耗量.
 *
 * Renderer `RawMessage.usage` is often empty at finalize time; transcript
 * lines are the authoritative source (see transcript-scan.ts).
 */

import { access, readFile } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { logger } from '../logger';
import { getOpenClawConfigDir } from '../paths';
import {
  extractSessionIdFromTranscriptFileName,
  parseUsageEntriesFromJsonl,
  type TokenUsageHistoryEntry,
} from '../token-usage-core';
import { parseTrajectoryUsageSupplements } from '../token-usage-trajectory';
import type { ExecutionRecord } from './types';

const SAFE_AGENT_ID = /^[A-Za-z0-9._-]+$/;
const MATCH_TOLERANCE_MS = 5 * 60 * 1000;

function parseReportDateTimeLocal(value: string | undefined): number | null {
  const text = (value ?? '').trim();
  if (!text) return null;
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!match) {
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const [, year, month, day, hour, minute, second] = match;
  const ms = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  ).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function needsTokenEnrichment(record: ExecutionRecord): boolean {
  if (typeof record.input_tokens !== 'number'
    || typeof record.output_tokens !== 'number'
    || typeof record.cache_read_tokens !== 'number') {
    return true;
  }
  // Renderer usage is often empty/zero; prefer transcript for successful turns.
  return record.status === 'success'
    && record.input_tokens === 0
    && record.output_tokens === 0
    && record.cache_read_tokens === 0;
}

function pickBestUsageEntry(
  entries: TokenUsageHistoryEntry[],
  startedAtMs: number | null,
  endedAtMs: number | null,
): TokenUsageHistoryEntry | null {
  const available = entries.filter((entry) => entry.usageStatus === 'available');
  if (available.length === 0) return null;

  const anchorMs = endedAtMs ?? startedAtMs;
  if (anchorMs == null) {
    return available[0] ?? null;
  }

  const windowStart = (startedAtMs ?? anchorMs) - MATCH_TOLERANCE_MS;
  const windowEnd = anchorMs + MATCH_TOLERANCE_MS;

  let best: TokenUsageHistoryEntry | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const entry of available) {
    const tsMs = Date.parse(entry.timestamp);
    if (!Number.isFinite(tsMs)) continue;
    if (tsMs < windowStart || tsMs > windowEnd) continue;
    const delta = Math.abs(tsMs - anchorMs);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = entry;
    }
  }
  return best;
}

function getSessionEntryFileInfo(
  entry: Record<string, unknown>,
  options?: { preferId?: boolean },
): { fileName?: string; resolvedPath?: string } {
  let fileName = (entry.file ?? entry.fileName ?? entry.path) as string | undefined;
  const resolvedPath = entry.sessionFile as string | undefined;
  const uuidVal = (entry.id ?? entry.sessionId) as string | undefined;
  if (uuidVal && (options?.preferId || !fileName)) {
    fileName = uuidVal.endsWith('.jsonl') ? uuidVal : `${uuidVal}.jsonl`;
  }
  return { fileName, resolvedPath };
}

async function readSessionsJson(sessionsJsonPath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(sessionsJsonPath, 'utf8');
    if (!raw.trim()) return {};
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function resolveTranscriptPathFromIndex(
  sessionKey: string,
  agentId: string,
  sessionsDir: string,
  sessionsJson: Record<string, unknown>,
): string | null {
  const sessionSegment = sessionKey.split(':').slice(2).join(':');
  const fallbackPath = join(sessionsDir, `${sessionSegment}.jsonl`);

  let fileName: string | undefined;
  let resolvedPath: string | undefined;

  if (Array.isArray(sessionsJson.sessions)) {
    const entry = (sessionsJson.sessions as Array<Record<string, unknown>>)
      .find((item) => item.key === sessionKey || item.sessionKey === sessionKey);
    if (entry) {
      ({ fileName, resolvedPath } = getSessionEntryFileInfo(entry));
    }
  }

  if (!fileName && sessionsJson[sessionKey] != null) {
    const value = sessionsJson[sessionKey];
    if (typeof value === 'string') {
      fileName = value;
    } else if (typeof value === 'object' && value !== null) {
      ({ fileName, resolvedPath } = getSessionEntryFileInfo(value as Record<string, unknown>, { preferId: true }));
    }
  }

  if (resolvedPath && isAbsolute(resolvedPath)) return resolvedPath;
  if (fileName) {
    return isAbsolute(fileName) ? fileName : join(sessionsDir, fileName);
  }
  return fallbackPath;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function loadUsageEntriesForSessionKey(sessionKey: string): Promise<TokenUsageHistoryEntry[]> {
  if (!sessionKey.startsWith('agent:')) return [];
  const parts = sessionKey.split(':');
  if (parts.length < 3) return [];

  const agentId = parts[1] ?? '';
  if (!SAFE_AGENT_ID.test(agentId)) return [];

  const sessionsDir = join(getOpenClawConfigDir(), 'agents', agentId, 'sessions');
  const sessionsJsonPath = join(sessionsDir, 'sessions.json');
  const sessionsJson = await readSessionsJson(sessionsJsonPath);

  let transcriptPath = sessionsJson
    ? resolveTranscriptPathFromIndex(sessionKey, agentId, sessionsDir, sessionsJson)
    : join(sessionsDir, `${parts.slice(2).join(':')}.jsonl`);

  if (!transcriptPath) return [];

  if (!(await fileExists(transcriptPath))) {
    const fallback = join(sessionsDir, `${parts.slice(2).join(':')}.jsonl`);
    if (fallback !== transcriptPath && await fileExists(fallback)) {
      transcriptPath = fallback;
    } else {
      return [];
    }
  }

  let content: string;
  try {
    content = await readFile(transcriptPath, 'utf8');
  } catch (error) {
    logger.debug(`[UsageReport] execution enrich: failed to read ${transcriptPath}:`, error);
    return [];
  }

  const sessionId = extractSessionIdFromTranscriptFileName(basename(transcriptPath))
    ?? parts.slice(2).join(':');

  let trajectorySupplements = [];
  if (transcriptPath.endsWith('.jsonl')) {
    const trajectoryPath = transcriptPath.replace(/\.jsonl$/, '.trajectory.jsonl');
    try {
      const trajectoryContent = await readFile(trajectoryPath, 'utf8');
      trajectorySupplements = parseTrajectoryUsageSupplements(trajectoryContent);
    } catch {
      // optional
    }
  }

  return parseUsageEntriesFromJsonl(content, { sessionId, agentId }, undefined, {
    trajectorySupplements,
  });
}

function applyUsageToRecord(
  record: ExecutionRecord,
  usage: TokenUsageHistoryEntry,
): ExecutionRecord {
  return {
    ...record,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cache_read_tokens: usage.cacheReadTokens,
  };
}

/**
 * Fill missing execution token fields from session transcripts before upload.
 * Records that already carry all three fields are left unchanged.
 */
export async function enrichExecutionRecordsFromTranscripts(
  records: ExecutionRecord[],
): Promise<ExecutionRecord[]> {
  if (records.length === 0) return records;

  const transcriptCache = new Map<string, TokenUsageHistoryEntry[]>();
  let enriched = 0;

  const next = await Promise.all(records.map(async (record) => {
    if (!needsTokenEnrichment(record)) return record;

    const sessionKey = record.conversation_id.trim();
    if (!sessionKey) return record;

    let entries = transcriptCache.get(sessionKey);
    if (!entries) {
      entries = await loadUsageEntriesForSessionKey(sessionKey);
      transcriptCache.set(sessionKey, entries);
    }
    if (entries.length === 0) return record;

    const startedAtMs = parseReportDateTimeLocal(record.started_at);
    const endedAtMs = parseReportDateTimeLocal(record.ended_at);
    const match = pickBestUsageEntry(entries, startedAtMs, endedAtMs);
    if (!match) return record;

    enriched += 1;
    return applyUsageToRecord(record, match);
  }));

  if (enriched > 0) {
    logger.info(`[UsageReport] execution enrich: filled tokens for ${enriched}/${records.length} record(s) from transcript`);
  }

  return next;
}

export {
  parseReportDateTimeLocal,
  pickBestUsageEntry,
  needsTokenEnrichment,
};
