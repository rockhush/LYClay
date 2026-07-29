import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { getOpenClawConfigDir } from './paths';
import { extractSessionIdFromTranscriptFileName } from './token-usage-core';

export interface LogSessionContext {
  sessionKey?: string;
  sessionId?: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validUuid(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return UUID_PATTERN.test(normalized) ? normalized : undefined;
}

function agentIdFromSessionKey(sessionKey: string): string | undefined {
  const [namespace, agentId] = sessionKey.split(':');
  if (namespace !== 'agent' || !agentId || !/^[a-z0-9][a-z0-9._-]*$/i.test(agentId)) return undefined;
  return agentId;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export async function resolveLogSessionContext(
  rawSessionKey: string | undefined,
  options: { openClawDir?: string } = {},
): Promise<LogSessionContext> {
  const sessionKey = rawSessionKey?.trim();
  if (!sessionKey) return {};

  const fallback = { sessionKey };
  const agentId = agentIdFromSessionKey(sessionKey);
  if (!agentId) return fallback;

  try {
    const sessionsPath = join(
      options.openClawDir ?? getOpenClawConfigDir(),
      'agents',
      agentId,
      'sessions',
      'sessions.json',
    );
    const index = asRecord(JSON.parse(await readFile(sessionsPath, 'utf8')));
    const entry = asRecord(index?.[sessionKey]);
    if (!entry) return fallback;

    const sessionFile = typeof entry.sessionFile === 'string' ? entry.sessionFile.trim() : '';
    const fileSessionId = sessionFile
      ? validUuid(extractSessionIdFromTranscriptFileName(basename(sessionFile)))
      : undefined;
    const sessionId = fileSessionId ?? validUuid(entry.sessionId) ?? validUuid(entry.id);

    return sessionId ? { sessionKey, sessionId } : fallback;
  } catch {
    return fallback;
  }
}
