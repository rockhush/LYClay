import { readFile, stat, unlink } from 'fs/promises';
import path from 'path';

type LoggerLike = {
  info: (message: string, details?: Record<string, unknown>) => void;
  warn: (message: string, details?: Record<string, unknown>) => void;
};

type SessionStoreEntry = {
  sessionFile?: unknown;
  status?: unknown;
};

type LockOwner = {
  pid?: unknown;
  createdAt?: unknown;
};

export type SessionTranscriptLockRecoveryResult =
  | { recovered: true; lockPath: string; sessionFile: string; lockAgeMs: number }
  | { recovered: false; reason: string; lockPath?: string; sessionFile?: string; lockAgeMs?: number };

const DEFAULT_MIN_LOCK_AGE_MS = 10_000;
const ACTIVE_SESSION_STATUSES = new Set(['running', 'processing', 'queued', 'pending']);

function parseAgentId(sessionKey: string): string | null {
  if (!sessionKey.startsWith('agent:')) return null;
  const parts = sessionKey.split(':');
  return parts[1]?.trim() || null;
}

function isActiveSessionStatus(status: unknown): boolean {
  return typeof status === 'string' && ACTIVE_SESSION_STATUSES.has(status.toLowerCase());
}

function isJsonlSessionFile(filePath: string, sessionsDir: string): boolean {
  const resolved = path.resolve(filePath);
  const resolvedRoot = path.resolve(sessionsDir);
  const relative = path.relative(resolvedRoot, resolved);
  return Boolean(relative)
    && !relative.startsWith('..')
    && !path.isAbsolute(relative)
    && path.basename(resolved).endsWith('.jsonl');
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

export async function recoverOrphanedSessionTranscriptLock(params: {
  sessionKey: string | null | undefined;
  openclawDir: string;
  currentPid?: number;
  nowMs?: number;
  minLockAgeMs?: number;
  reason: string;
  logger: LoggerLike;
}): Promise<SessionTranscriptLockRecoveryResult> {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) return { recovered: false, reason: 'missing-session-key' };

  const agentId = parseAgentId(sessionKey);
  if (!agentId) return { recovered: false, reason: 'unsupported-session-key' };

  const sessionsDir = path.join(params.openclawDir, 'agents', agentId, 'sessions');
  const sessionsJsonPath = path.join(sessionsDir, 'sessions.json');
  const sessionsJson = await readJsonFile<Record<string, SessionStoreEntry>>(sessionsJsonPath);
  const entry = sessionsJson?.[sessionKey];
  if (!entry) return { recovered: false, reason: 'session-entry-missing' };
  if (isActiveSessionStatus(entry.status)) return { recovered: false, reason: 'session-active' };

  const rawSessionFile = typeof entry.sessionFile === 'string' ? entry.sessionFile : '';
  if (!rawSessionFile) return { recovered: false, reason: 'session-file-missing' };

  const sessionFile = path.isAbsolute(rawSessionFile)
    ? rawSessionFile
    : path.join(sessionsDir, rawSessionFile);
  if (!isJsonlSessionFile(sessionFile, sessionsDir)) {
    return { recovered: false, reason: 'session-file-outside-root', sessionFile };
  }

  const lockPath = `${sessionFile}.lock`;
  let lockStat;
  try {
    lockStat = await stat(lockPath);
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') {
      return { recovered: false, reason: 'lock-missing', lockPath, sessionFile };
    }
    return { recovered: false, reason: 'lock-stat-failed', lockPath, sessionFile };
  }

  const lockOwner = await readJsonFile<LockOwner>(lockPath);
  if (!lockOwner || typeof lockOwner !== 'object') {
    return { recovered: false, reason: 'lock-owner-unreadable', lockPath, sessionFile };
  }

  const currentPid = params.currentPid ?? process.pid;
  if (lockOwner.pid !== currentPid) {
    return { recovered: false, reason: 'lock-owned-by-other-process', lockPath, sessionFile };
  }

  const createdAtMs = typeof lockOwner.createdAt === 'string'
    ? Date.parse(lockOwner.createdAt)
    : NaN;
  const fallbackCreatedAtMs = Number.isFinite(lockStat.mtimeMs) ? lockStat.mtimeMs : Date.now();
  const lockCreatedAtMs = Number.isFinite(createdAtMs) ? createdAtMs : fallbackCreatedAtMs;
  const nowMs = params.nowMs ?? Date.now();
  const lockAgeMs = Math.max(0, nowMs - lockCreatedAtMs);
  const minLockAgeMs = params.minLockAgeMs ?? DEFAULT_MIN_LOCK_AGE_MS;
  if (lockAgeMs < minLockAgeMs) {
    return { recovered: false, reason: 'lock-too-new', lockPath, sessionFile, lockAgeMs };
  }

  await unlink(lockPath);
  params.logger.warn('[gateway:session-lock-recovery] removed orphaned session transcript lock', {
    reason: params.reason,
    sessionKey,
    sessionFile,
    lockPath,
    lockAgeMs,
    pid: currentPid,
  });
  return { recovered: true, lockPath, sessionFile, lockAgeMs };
}
