import { readFile, stat } from 'fs/promises';
import path from 'path';
import { homedir } from 'os';

type SessionStoreEntry = {
  sessionFile?: unknown;
  status?: unknown;
};

const ACTIVE_SESSION_STATUSES = new Set(['running', 'processing', 'queued', 'pending']);
const DEFAULT_RECENT_ACTIVITY_MS = 3 * 60_000;

function parseAgentId(sessionKey: string): string | null {
  if (!sessionKey.startsWith('agent:')) return null;
  return sessionKey.split(':')[1]?.trim() || null;
}

function isActiveSessionStatus(status: unknown): boolean {
  return typeof status === 'string' && ACTIVE_SESSION_STATUSES.has(status.toLowerCase());
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

/**
 * sessions.json can keep status=processing after a run already finished.
 * Treat disk status as live only when Gateway still tracks the run, a live lock
 * exists, or the transcript/lock was touched recently.
 */
export async function isSessionProcessingLiveOnDisk(params: {
  sessionKey: string;
  openclawDir?: string;
  hasTrackedActiveRun: boolean;
  currentPid?: number;
  nowMs?: number;
  recentActivityMs?: number;
}): Promise<boolean> {
  if (params.hasTrackedActiveRun) return true;

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
  if (!entry || !isActiveSessionStatus(entry.status)) return false;

  const sessionFile = resolveSessionTranscriptPath(sessionsDir, sessionKey, entry);
  if (!sessionFile) return false;

  const nowMs = params.nowMs ?? Date.now();
  const recentActivityMs = params.recentActivityMs ?? DEFAULT_RECENT_ACTIVITY_MS;
  const currentPid = params.currentPid ?? process.pid;

  const lockPath = `${sessionFile}.lock`;
  try {
    const lockStat = await stat(lockPath);
    const lockOwner = JSON.parse(await readFile(lockPath, 'utf8')) as { pid?: unknown };
    const lockPid = lockOwner?.pid;
    const lockPidAlive = isPidAlive(lockPid);
    if (lockPidAlive === true) return true;
    if (lockPid === currentPid) return true;
    if (nowMs - lockStat.mtimeMs < recentActivityMs) return true;
  } catch {
    // No lock — fall through to transcript mtime.
  }

  try {
    const transcriptStat = await stat(sessionFile);
    if (nowMs - transcriptStat.mtimeMs < recentActivityMs) return true;
  } catch {
    return false;
  }

  return false;
}
