import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getOpenClawConfigDir } from '../utils/paths';
import { isUiInAppCronJob, type CronJobDeliveryStateLike } from './cron-stale-errors';

export interface CronRunLogEntry {
  jobId?: string;
  action?: string;
  status?: string;
  error?: string;
  summary?: string;
  sessionId?: string;
  sessionKey?: string;
  runId?: string;
  source?: string;
  ts?: number;
  runAtMs?: number;
  durationMs?: number;
  model?: string;
  provider?: string;
}

function cronRunLogPath(jobId: string): string {
  return join(getOpenClawConfigDir(), 'cron', 'runs', `${jobId}.jsonl`);
}

export async function appendCronRunLogEntry(jobId: string, entry: CronRunLogEntry): Promise<void> {
  const logPath = cronRunLogPath(jobId);
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(
    logPath,
    `${JSON.stringify({ jobId, action: 'finished', ts: Date.now(), ...entry })}\n`,
    'utf8',
  );
}

export interface CronLastRunView {
  time: string;
  success: boolean;
  error?: string;
  duration?: number;
}

function normalizeTimestampMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export async function readCronRunLog(jobId: string): Promise<CronRunLogEntry[]> {
  const logPath = join(getOpenClawConfigDir(), 'cron', 'runs', `${jobId}.jsonl`);
  const raw = await readFile(logPath, 'utf8').catch(() => '');
  if (!raw.trim()) return [];

  const entries: CronRunLogEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as CronRunLogEntry;
      if (!entry) continue;
      if (entry.jobId && entry.jobId !== jobId) continue;
      if (entry.action && entry.action !== 'finished') continue;
      entries.push(entry);
    } catch {
      // Ignore malformed log lines.
    }
  }
  return entries;
}

export function latestFinishedCronRun(entries: CronRunLogEntry[]): {
  runAtMs: number;
  success: boolean;
  error?: string;
  durationMs?: number;
} | null {
  let latest: {
    runAtMs: number;
    success: boolean;
    error?: string;
    durationMs?: number;
  } | null = null;

  for (const entry of entries) {
    if (entry.action && entry.action !== 'finished') continue;
    const runAtMs = normalizeTimestampMs(entry.runAtMs) ?? normalizeTimestampMs(entry.ts);
    if (!runAtMs) continue;
    const status = typeof entry.status === 'string' ? entry.status.toLowerCase() : '';
    const success = status !== 'error';
    const error = typeof entry.error === 'string' ? entry.error.trim() : undefined;
    const durationMs = typeof entry.durationMs === 'number' && Number.isFinite(entry.durationMs)
      ? entry.durationMs
      : undefined;

    if (!latest || runAtMs > latest.runAtMs) {
      latest = { runAtMs, success, error, durationMs };
    }
  }

  return latest;
}

export function buildLastRunViewFromState(state: {
  lastRunAtMs?: number;
  lastStatus?: string;
  lastError?: string;
  lastDurationMs?: number;
} | undefined): CronLastRunView | undefined {
  if (!state?.lastRunAtMs) return undefined;
  return {
    time: new Date(state.lastRunAtMs).toISOString(),
    success: state.lastStatus === 'ok',
    error: state.lastError,
    duration: state.lastDurationMs,
  };
}

export function buildLastRunViewFromRunLog(entry: {
  runAtMs: number;
  success: boolean;
  error?: string;
  durationMs?: number;
}): CronLastRunView {
  return {
    time: new Date(entry.runAtMs).toISOString(),
    success: entry.success,
    error: entry.error,
    duration: entry.durationMs,
  };
}

/** Prefer the newest last-run timestamp between Gateway state and the on-disk run log. */
export function resolveEffectiveLastRunAtMs(
  job: CronJobDeliveryStateLike & { id?: string; state?: { lastRunAtMs?: number } },
  runs: CronRunLogEntry[],
): number {
  const fromState = job.state?.lastRunAtMs ?? 0;
  if (!isUiInAppCronJob(job)) return fromState;
  const latest = latestFinishedCronRun(runs);
  return latest && latest.runAtMs > fromState ? latest.runAtMs : fromState;
}

export function resolveInAppCronLastRun(
  job: CronJobDeliveryStateLike & { state?: {
    lastRunAtMs?: number;
    lastStatus?: string;
    lastError?: string;
    lastDurationMs?: number;
  } },
  runs: CronRunLogEntry[],
): CronLastRunView | undefined {
  const fromState = buildLastRunViewFromState(job.state);
  if (!isUiInAppCronJob(job)) return fromState;

  const latest = latestFinishedCronRun(runs);
  if (!latest) return fromState;

  const stateMs = job.state?.lastRunAtMs ?? 0;
  if (latest.runAtMs <= stateMs) return fromState;

  return buildLastRunViewFromRunLog(latest);
}

export async function resolveInAppCronLastRunForJob(
  job: CronJobDeliveryStateLike & { id: string; state?: {
    lastRunAtMs?: number;
    lastStatus?: string;
    lastError?: string;
    lastDurationMs?: number;
  } },
): Promise<CronLastRunView | undefined> {
  const runs = isUiInAppCronJob(job) ? await readCronRunLog(job.id) : [];
  return resolveInAppCronLastRun(job, runs);
}
