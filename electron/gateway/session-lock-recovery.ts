import { readFile, stat, unlink, writeFile } from 'fs/promises';
import path from 'path';

type LoggerLike = {
  info: (message: string, details?: Record<string, unknown>) => void;
  warn: (message: string, details?: Record<string, unknown>) => void;
};

type SessionStoreEntry = {
  sessionFile?: unknown;
  status?: unknown;
  recoveredAt?: unknown;
  recoveryReason?: unknown;
};

type LockOwner = {
  pid?: unknown;
  createdAt?: unknown;
};

export type SessionTranscriptLockSnapshot =
  | {
      exists: true;
      sessionKey: string;
      sessionFile: string;
      lockPath: string;
      lockAgeMs: number;
      lockPid?: unknown;
      lockPidAlive: boolean | null;
      currentPid: number;
      lockBelongsToCurrentGateway: boolean;
      sessionStatus: unknown;
    }
  | {
      exists: false;
      sessionKey: string;
      reason: string;
      sessionFile?: string;
      lockPath?: string;
      details?: Record<string, unknown>;
    };

export type SessionTranscriptLockRecoveryResult =
  | { recovered: true; lockPath: string; sessionFile: string; lockAgeMs: number; lockPid?: unknown; lockPidAlive?: boolean | null }
  | { recovered: false; reason: string; lockPath?: string; sessionFile?: string; lockAgeMs?: number; details?: Record<string, unknown> };

export type StaleSessionRecoveryReason =
  | 'missing-session-key'
  | 'missing-diagnostic'
  | 'tracked-active-run'
  | 'lock-owned-by-live-process'
  | 'session-recently-active'
  | 'lock-missing'
  | 'session-entry-missing'
  | 'session-file-missing'
  | 'session-file-outside-root'
  | 'unsupported-session-key'
  | 'unsafe-state'
  | 'lock-owner-unreadable'
  | 'lock-stat-failed';

export type StaleSessionRecoveryResult =
  | {
      ok: true;
      recovered: true;
      sessionKey: string;
      previousStatus: string | null;
      nextStatus: string;
      removedLockPath: string | null;
      reason: 'stale-empty-final';
    }
  | {
      ok: true;
      recovered: false;
      sessionKey: string;
      reason: StaleSessionRecoveryReason;
      details?: Record<string, unknown>;
    }
  | {
      ok: false;
      error: string;
    };

const DEFAULT_MIN_LOCK_AGE_MS = 10_000;
const DEFAULT_STALE_THRESHOLD_MS = 2 * 60_000;
const ACTIVE_SESSION_STATUSES = new Set(['running', 'processing', 'queued', 'pending']);
const EMPTY_FINAL_RECOVERABLE_TERMINAL_STATUSES = new Set(['done', 'completed', 'success', 'stale-recovered']);

function parseAgentId(sessionKey: string): string | null {
  if (!sessionKey.startsWith('agent:')) return null;
  const parts = sessionKey.split(':');
  return parts[1]?.trim() || null;
}

function isActiveSessionStatus(status: unknown): boolean {
  return typeof status === 'string' && ACTIVE_SESSION_STATUSES.has(status.toLowerCase());
}

function isRecoverableEmptyFinalTerminalStatus(status: unknown): boolean {
  return typeof status === 'string' && EMPTY_FINAL_RECOVERABLE_TERMINAL_STATUSES.has(status.toLowerCase());
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

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function isPidAlive(pid: unknown): boolean | null {
  if (!Number.isInteger(pid) || (pid as number) <= 0) return null;
  try {
    process.kill(pid as number, 0);
    return true;
  } catch {
    return false;
  }
}

function getLockCreatedAtMs(lockOwner: LockOwner | null, lockMtimeMs: number, nowMs: number): number {
  const parsed = typeof lockOwner?.createdAt === 'string' ? Date.parse(lockOwner.createdAt) : NaN;
  if (Number.isFinite(parsed)) return parsed;
  return Number.isFinite(lockMtimeMs) ? lockMtimeMs : nowMs;
}

export async function inspectSessionTranscriptLock(params: {
  sessionKey: string | null | undefined;
  openclawDir: string;
  currentPid?: number;
  nowMs?: number;
}): Promise<SessionTranscriptLockSnapshot> {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) return { exists: false, sessionKey: '', reason: 'missing-session-key' };

  const agentId = parseAgentId(sessionKey);
  if (!agentId) return { exists: false, sessionKey, reason: 'unsupported-session-key' };

  const sessionsDir = path.join(params.openclawDir, 'agents', agentId, 'sessions');
  const sessionsJsonPath = path.join(sessionsDir, 'sessions.json');
  const sessionsJson = await readJsonFile<Record<string, SessionStoreEntry>>(sessionsJsonPath);
  const entry = sessionsJson?.[sessionKey];
  if (!entry) return { exists: false, sessionKey, reason: 'session-entry-missing' };

  const rawSessionFile = typeof entry.sessionFile === 'string' ? entry.sessionFile : '';
  if (!rawSessionFile) return { exists: false, sessionKey, reason: 'session-file-missing' };

  const sessionFile = path.isAbsolute(rawSessionFile)
    ? rawSessionFile
    : path.join(sessionsDir, rawSessionFile);
  if (!isJsonlSessionFile(sessionFile, sessionsDir)) {
    return { exists: false, sessionKey, reason: 'session-file-outside-root', sessionFile };
  }

  const lockPath = `${sessionFile}.lock`;
  let lockStat;
  try {
    lockStat = await stat(lockPath);
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') {
      return { exists: false, sessionKey, reason: 'lock-missing', sessionFile, lockPath };
    }
    return { exists: false, sessionKey, reason: 'lock-stat-failed', sessionFile, lockPath };
  }

  const lockOwner = await readJsonFile<LockOwner>(lockPath);
  if (!lockOwner || typeof lockOwner !== 'object') {
    return { exists: false, sessionKey, reason: 'lock-owner-unreadable', sessionFile, lockPath };
  }

  const currentPid = params.currentPid ?? process.pid;
  const nowMs = params.nowMs ?? Date.now();
  const lockPid = lockOwner.pid;
  const lockPidAlive = isPidAlive(lockPid);
  const lockCreatedAtMs = getLockCreatedAtMs(lockOwner, lockStat.mtimeMs, nowMs);
  return {
    exists: true,
    sessionKey,
    sessionFile,
    lockPath,
    lockAgeMs: Math.max(0, nowMs - lockCreatedAtMs),
    lockPid,
    lockPidAlive,
    currentPid,
    lockBelongsToCurrentGateway: lockPid === currentPid,
    sessionStatus: entry.status,
  };
}

export async function recoverOrphanedSessionTranscriptLock(params: {
  sessionKey: string | null | undefined;
  openclawDir: string;
  currentPid?: number;
  nowMs?: number;
  minLockAgeMs?: number;
  allowCurrentGatewayActiveLockRecovery?: boolean;
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
  const sessionWasActive = isActiveSessionStatus(entry.status);

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
  const nowMs = params.nowMs ?? Date.now();
  const lockPid = lockOwner.pid;
  const lockPidAlive = isPidAlive(lockPid);
  const lockBelongsToCurrentGateway = lockPid === currentPid;
  const lockOwnerIsDead = lockPidAlive === false;
  const canRecoverCurrentGatewayActiveLock = Boolean(
    params.allowCurrentGatewayActiveLockRecovery && lockBelongsToCurrentGateway,
  );
  if (sessionWasActive && !canRecoverCurrentGatewayActiveLock && (lockBelongsToCurrentGateway || !lockOwnerIsDead)) {
    return {
      recovered: false,
      reason: 'session-active',
      lockPath,
      sessionFile,
      details: { lockPid, lockPidAlive, currentPid, lockBelongsToCurrentGateway },
    };
  }
  if (!lockBelongsToCurrentGateway && !lockOwnerIsDead) {
    return {
      recovered: false,
      reason: 'lock-owned-by-live-process',
      lockPath,
      sessionFile,
      details: { lockPid, lockPidAlive, currentPid },
    };
  }

  const lockCreatedAtMs = getLockCreatedAtMs(lockOwner, lockStat.mtimeMs, nowMs);
  const lockAgeMs = Math.max(0, nowMs - lockCreatedAtMs);
  const minLockAgeMs = params.minLockAgeMs ?? DEFAULT_MIN_LOCK_AGE_MS;
  if (lockAgeMs < minLockAgeMs) {
    return { recovered: false, reason: 'lock-too-new', lockPath, sessionFile, lockAgeMs };
  }

  await unlink(lockPath);
  if (sessionWasActive && sessionsJson) {
    sessionsJson[sessionKey] = {
      ...entry,
      status: 'stale-recovered',
      recoveredAt: new Date(nowMs).toISOString(),
      recoveryReason: params.reason,
    };
    await writeJsonFile(sessionsJsonPath, sessionsJson);
  }
  params.logger.warn('[gateway:session-lock-recovery] removed orphaned session transcript lock', {
    reason: params.reason,
    sessionKey,
    sessionFile,
    lockPath,
    lockAgeMs,
    lockPid,
    lockPidAlive,
    currentPid,
    previousStatus: sessionWasActive ? entry.status : undefined,
    nextStatus: sessionWasActive ? 'stale-recovered' : undefined,
  });
  return { recovered: true, lockPath, sessionFile, lockAgeMs, lockPid, lockPidAlive };
}

export async function recoverStaleSessionAfterEmptyFinal(params: {
  sessionKey: string | null | undefined;
  openclawDir: string;
  currentPid?: number;
  nowMs?: number;
  staleThresholdMs?: number;
  hasRecentEmptyFinalNoOutput: boolean;
  hasTrackedActiveRun: boolean;
  lastVisibleProgressAt?: number | null;
  logger: LoggerLike;
}): Promise<StaleSessionRecoveryResult> {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) return { ok: true, recovered: false, sessionKey: '', reason: 'missing-session-key' };
  if (!params.hasRecentEmptyFinalNoOutput) {
    return { ok: true, recovered: false, sessionKey, reason: 'missing-diagnostic' };
  }
  if (params.hasTrackedActiveRun) {
    return { ok: true, recovered: false, sessionKey, reason: 'tracked-active-run' };
  }

  const nowMs = params.nowMs ?? Date.now();
  const staleThresholdMs = params.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;
  if (params.lastVisibleProgressAt && nowMs - params.lastVisibleProgressAt < staleThresholdMs) {
    return {
      ok: true,
      recovered: false,
      sessionKey,
      reason: 'session-recently-active',
      details: { lastVisibleProgressAt: params.lastVisibleProgressAt, staleThresholdMs },
    };
  }

  const agentId = parseAgentId(sessionKey);
  if (!agentId) return { ok: true, recovered: false, sessionKey, reason: 'unsupported-session-key' };

  const sessionsDir = path.join(params.openclawDir, 'agents', agentId, 'sessions');
  const sessionsJsonPath = path.join(sessionsDir, 'sessions.json');
  const sessionsJson = await readJsonFile<Record<string, SessionStoreEntry>>(sessionsJsonPath);
  const entry = sessionsJson?.[sessionKey];
  if (!sessionsJson || !entry) {
    return { ok: true, recovered: false, sessionKey, reason: 'session-entry-missing' };
  }

  const previousStatus = typeof entry.status === 'string' ? entry.status : null;
  const sessionWasActive = isActiveSessionStatus(entry.status);
  const terminalEmptyFinalConflict = isRecoverableEmptyFinalTerminalStatus(entry.status);
  if (!sessionWasActive && !terminalEmptyFinalConflict) {
    return {
      ok: true,
      recovered: false,
      sessionKey,
      reason: 'unsafe-state',
      details: { status: entry.status },
    };
  }

  const rawSessionFile = typeof entry.sessionFile === 'string' ? entry.sessionFile : '';
  if (!rawSessionFile) return { ok: true, recovered: false, sessionKey, reason: 'session-file-missing' };

  const sessionFile = path.isAbsolute(rawSessionFile)
    ? rawSessionFile
    : path.join(sessionsDir, rawSessionFile);
  if (!isJsonlSessionFile(sessionFile, sessionsDir)) {
    return { ok: true, recovered: false, sessionKey, reason: 'session-file-outside-root', details: { sessionFile } };
  }

  const lockPath = `${sessionFile}.lock`;
  let transcriptStat;
  let lockStat;
  try {
    transcriptStat = await stat(sessionFile);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'ENOENT') {
      return { ok: true, recovered: false, sessionKey, reason: 'session-file-missing', details: { sessionFile } };
    }
    return { ok: true, recovered: false, sessionKey, reason: 'lock-stat-failed', details: { lockPath, sessionFile, error: String(error) } };
  }

  const transcriptAgeMs = nowMs - transcriptStat.mtimeMs;
  try {
    lockStat = await stat(lockPath);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'ENOENT') {
      if (!terminalEmptyFinalConflict) {
        return { ok: true, recovered: false, sessionKey, reason: 'lock-missing', details: { lockPath, sessionFile } };
      }

      const nextStatus = 'stale-recovered';
      sessionsJson[sessionKey] = {
        ...entry,
        status: nextStatus,
        recoveredAt: new Date(nowMs).toISOString(),
        recoveryReason: 'stale-empty-final',
      };
      await writeJsonFile(sessionsJsonPath, sessionsJson);

      params.logger.warn('[gateway:session-stale-recovery] marked empty-final terminal session as recovered', {
        sessionKey,
        sessionFile,
        lockPath,
        previousStatus,
        nextStatus,
        recoveryReason: 'stale-empty-final',
        evidence: {
          transcriptAgeMs,
          lockMissing: true,
        },
      });

      return {
        ok: true,
        recovered: true,
        sessionKey,
        previousStatus,
        nextStatus,
        removedLockPath: null,
        reason: 'stale-empty-final',
      };
    }
    return { ok: true, recovered: false, sessionKey, reason: 'lock-stat-failed', details: { lockPath, sessionFile, error: String(error) } };
  }

  const lockMtimeAgeMs = nowMs - lockStat.mtimeMs;
  if (sessionWasActive && (transcriptAgeMs < staleThresholdMs || lockMtimeAgeMs < staleThresholdMs)) {
    return {
      ok: true,
      recovered: false,
      sessionKey,
      reason: 'session-recently-active',
      details: { transcriptAgeMs, lockMtimeAgeMs, staleThresholdMs },
    };
  }

  const lockOwner = await readJsonFile<LockOwner>(lockPath);
  if (!lockOwner || typeof lockOwner !== 'object') {
    return { ok: true, recovered: false, sessionKey, reason: 'lock-owner-unreadable', details: { lockPath } };
  }

  const currentPid = params.currentPid ?? process.pid;
  const lockPid = lockOwner.pid;
  const lockPidAlive = isPidAlive(lockPid);
  const lockCreatedAtMs = getLockCreatedAtMs(lockOwner, lockStat.mtimeMs, nowMs);
  const lockAgeMs = Math.max(0, nowMs - lockCreatedAtMs);
  const lockBelongsToCurrentGateway = lockPid === currentPid;
  const lockOwnerIsDead = lockPidAlive === false;
  if (!lockOwnerIsDead && !lockBelongsToCurrentGateway) {
    return {
      ok: true,
      recovered: false,
      sessionKey,
      reason: 'lock-owned-by-live-process',
      details: { lockPid, lockPidAlive, currentPid, lockPath },
    };
  }
  if (lockBelongsToCurrentGateway && lockAgeMs < staleThresholdMs) {
    return {
      ok: true,
      recovered: false,
      sessionKey,
      reason: 'session-recently-active',
      details: { lockAgeMs, staleThresholdMs, currentPid, lockPath },
    };
  }

  await unlink(lockPath);
  const nextStatus = 'stale-recovered';
  const nextEntry: SessionStoreEntry & Record<string, unknown> = {
    ...entry,
    status: nextStatus,
    recoveredAt: new Date(nowMs).toISOString(),
    recoveryReason: 'stale-empty-final',
  };
  sessionsJson[sessionKey] = nextEntry;
  await writeJsonFile(sessionsJsonPath, sessionsJson);

  params.logger.warn('[gateway:session-stale-recovery] recovered stale empty-final session', {
    sessionKey,
    sessionFile,
    lockPath,
    previousStatus,
    nextStatus,
    recoveryReason: 'stale-empty-final',
    evidence: {
      transcriptAgeMs,
      lockMtimeAgeMs,
      lockAgeMs,
      lockPid,
      lockPidAlive,
      currentPid,
    },
  });

  return {
    ok: true,
    recovered: true,
    sessionKey,
    previousStatus,
    nextStatus,
    removedLockPath: lockPath,
    reason: 'stale-empty-final',
  };
}
