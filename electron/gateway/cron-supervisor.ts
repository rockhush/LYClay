/**
 * Cron supervisor.
 *
 * The OpenClaw gateway owns the actual cron scheduler. Two real-world gaps
 * remain that this supervisor closes from the host side, without changing how
 * jobs are created, scheduled, or delivered:
 *
 *  1. Cold-start failures — when a scheduled job fires after the runtime has
 *     been idle (e.g. a once-a-day task), spinning up the isolated agent runner
 *     can exceed the gateway's internal setup timeout, leaving the run in an
 *     `error` state ("isolated agent setup timed out before runner start",
 *     "isolated agent run stalled before execution start"). The first attempt
 *     usually warms the runtime, so the supervisor re-triggers the job once and
 *     it typically succeeds.
 *
 *  2. Missed runs while offline — if the machine was off / asleep / the app was
 *     not running at the scheduled time, the occurrence is silently skipped. On
 *     startup the supervisor computes the most recent scheduled occurrence and,
 *     if the gateway has not run it, fires a single catch-up run.
 *
 * It only calls the existing `cron.list` / `cron.run` RPCs and persists a tiny
 * dedupe file, so it cannot corrupt gateway state. Every action is heavily
 * guarded to avoid duplicate or runaway runs.
 */

import { powerMonitor } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { logger } from '../utils/logger';
import { getOpenClawConfigDir } from '../utils/paths';
import {
  inferScheduleIntervalMs,
  isTransientCronError,
  previousScheduleOccurrenceMs,
  type GatewayCronScheduleLike,
} from './cron-schedule';

interface GatewayLike {
  getStatus: () => { state: string; warmupStatus?: 'idle' | 'warming' | 'ready' | 'failed' };
  rpc: <T>(method: string, params?: unknown, timeoutMs?: number) => Promise<T>;
}

interface SupervisedCronJob {
  id: string;
  enabled?: boolean;
  createdAtMs?: number;
  schedule?: GatewayCronScheduleLike;
  payload?: { kind?: string };
  state?: {
    nextRunAtMs?: number;
    lastRunAtMs?: number;
    lastStatus?: string;
    lastError?: string;
  };
}

interface SupervisorState {
  /** Occurrence (ms) we already fired a catch-up run for, keyed by job id. */
  handled: Record<string, number>;
  /** Last time (ms) we auto-retried a failed run, keyed by job id. */
  retried: Record<string, number>;
}

const STATE_FILE = join(getOpenClawConfigDir(), 'cron', '.lyclaw-cron-supervisor.json');

// Defer the first pass so the gateway can finish warmup and run its own on-time
// / catch-up firing before we step in. We only act on what it missed/failed.
const INITIAL_PASS_DELAY_MS = 90_000;
// Safety-net interval when no wake/focus events fire (unchanged behavior, faster than 5m).
const PERIODIC_PASS_INTERVAL_MS = 2 * 60_000;
// Brief settle after resume/unlock so the gateway websocket can recover before cron.run.
const REQUEST_PASS_DELAY_MS = 5_000;
// Skip redundant wake-triggered passes when a pass just completed (periodic still runs on schedule).
const MIN_WAKE_PASS_INTERVAL_MS = 45_000;

// Background (catch-up / retry) runs are fire-and-forget and never block the
// UI, so they can afford a patient timeout.
const CRON_RUN_TIMEOUT_MS = 180_000;
const CRON_LIST_TIMEOUT_MS = 8_000;
const RUN_TRANSPORT_ATTEMPTS = 2;
const RUN_TRANSPORT_RETRY_DELAY_MS = 5_000;

// Manual "立即运行" runs block the UI button, so keep the wait short. Worst case
// is MANUAL_RUN_TIMEOUT_MS * MANUAL_RUN_ATTEMPTS + one retry delay (~92s), vs.
// the background ceiling. A cold-start setup failure is returned by the gateway
// well before the timeout, so the typical wait is much shorter.
const MANUAL_RUN_TIMEOUT_MS = 45_000;
const MANUAL_RUN_ATTEMPTS = 2;
const MANUAL_RUN_RETRY_DELAY_MS = 2_000;

// Background catch-up/retry must ride out cold start: the AI provider is lazily
// initialized on the first run (60+s) and warmup is off by default, so the first
// attempt typically "stalls before execution start (context-engine)". These
// increasing delays let the provider finish warming so a later attempt succeeds.
// Non-transient errors (e.g. missing channel) abort immediately without waiting.
const BACKGROUND_RUN_RETRY_DELAYS_MS = [30_000, 60_000, 120_000, 180_000];

// If a warmup is actively in progress, wait (bounded) for it to settle before
// firing so we don't race provider initialization. Harmless when warmup is
// idle/disabled/ready (we proceed immediately and rely on the backoff above).
const WARMUP_WAIT_MAX_MS = 180_000;
const WARMUP_POLL_INTERVAL_MS = 3_000;

// Catch-up only applies to "sparse" schedules (>= 1h cadence); a missed
// every-few-minutes tick is irrelevant and would be noisy.
const CATCHUP_SPARSE_MIN_INTERVAL_MS = 60 * 60_000;
// The occurrence must be at least this overdue before we treat it as missed,
// so we never race the gateway's own on-time firing.
const CATCHUP_MIN_OVERDUE_MS = 2 * 60_000;
// Never resurrect occurrences older than this (avoid firing ancient backlog).
const CATCHUP_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

// Only auto-retry a failure that is still fresh, and at most once per job per
// hour, so a persistently-failing job can never enter a retry storm.
const RETRY_FRESH_WINDOW_MS = 30 * 60_000;
const RETRY_MIN_INTERVAL_MS = 60 * 60_000;

let started = false;
let gateway: GatewayLike | null = null;
let initialTimer: ReturnType<typeof setTimeout> | null = null;
let periodicTimer: ReturnType<typeof setInterval> | null = null;
let pendingPassTimer: ReturnType<typeof setTimeout> | null = null;
let pendingPassReason: string | null = null;
let wakeHooksRegistered = false;
let passInFlight = false;
let passQueued = false;
let lastPassCompletedAt = 0;
let state: SupervisorState = { handled: {}, retried: {} };
let stateLoaded = false;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unref(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval> | null): void {
  if (timer && typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }
}

async function loadState(): Promise<void> {
  if (stateLoaded) return;
  stateLoaded = true;
  try {
    const raw = await readFile(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<SupervisorState>;
    state = {
      handled: parsed.handled && typeof parsed.handled === 'object' ? parsed.handled : {},
      retried: parsed.retried && typeof parsed.retried === 'object' ? parsed.retried : {},
    };
  } catch {
    state = { handled: {}, retried: {} };
  }
}

async function persistState(): Promise<void> {
  try {
    await mkdir(dirname(STATE_FILE), { recursive: true });
    await writeFile(STATE_FILE, JSON.stringify(state), 'utf8');
  } catch (error) {
    logger.warn('[cron-supervisor] failed to persist state:', error);
  }
}

/**
 * Trigger a cron job via `cron.run` with a generous timeout and a transport-level
 * retry for transient failures. Returns the raw RPC result on success; throws on
 * final failure (preserving the existing trigger-path semantics for callers).
 */
export async function runCronJobWithRetry(
  gw: GatewayLike,
  id: string,
  opts?: { attempts?: number; timeoutMs?: number; retryDelayMs?: number },
): Promise<unknown> {
  const attempts = opts?.attempts ?? RUN_TRANSPORT_ATTEMPTS;
  const timeoutMs = opts?.timeoutMs ?? CRON_RUN_TIMEOUT_MS;
  const retryDelayMs = opts?.retryDelayMs ?? RUN_TRANSPORT_RETRY_DELAY_MS;

  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await gw.rpc('cron.run', { id, mode: 'force' }, timeoutMs);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const canRetry = attempt < attempts - 1 && isTransientCronError(message);
      if (!canRetry) break;
      logger.info(`[cron-supervisor] transient cron.run failure for ${id}, retrying once: ${message}`);
      await delay(retryDelayMs);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Manual ("立即运行") trigger: shorter, UI-blocking wait. Falls back to the same
 * transient retry behavior but with a tighter timeout so the user is not left
 * waiting on the background ceiling. The background supervisor still retries any
 * lingering transient failure later.
 */
export function triggerCronJobManually(gw: GatewayLike, id: string): Promise<unknown> {
  return runCronJobWithRetry(gw, id, {
    attempts: MANUAL_RUN_ATTEMPTS,
    timeoutMs: MANUAL_RUN_TIMEOUT_MS,
    retryDelayMs: MANUAL_RUN_RETRY_DELAY_MS,
  });
}

/** If a warmup is in progress, wait (bounded) for it to settle before firing. */
async function waitForWarmupIfInProgress(): Promise<void> {
  if (!gateway) return;
  const deadline = Date.now() + WARMUP_WAIT_MAX_MS;
  while (Date.now() < deadline) {
    const status = gateway.getStatus();
    if (status.state !== 'running') return;
    // Only 'warming' means provider init is actively running; for any other
    // value (ready/idle/failed/undefined) we proceed and let the backoff cover
    // the cold-start case.
    if (status.warmupStatus !== 'warming') return;
    await delay(WARMUP_POLL_INTERVAL_MS);
  }
}

/**
 * Run a cron job from the background supervisor with cold-start-tolerant backoff.
 * The first attempt usually triggers the gateway's lazy provider init and fails
 * with a transient "stalled before execution start" error; later attempts, after
 * the provider is warm, succeed. Never throws — background context.
 */
async function runCronJobInBackground(id: string): Promise<{ ok: boolean; error?: string }> {
  await waitForWarmupIfInProgress();

  const maxAttempts = BACKGROUND_RUN_RETRY_DELAYS_MS.length + 1;
  let lastError = '';
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (!gateway || gateway.getStatus().state !== 'running') {
      return { ok: false, error: lastError || 'gateway not running' };
    }
    try {
      await gateway.rpc('cron.run', { id, mode: 'force' }, CRON_RUN_TIMEOUT_MS);
      return { ok: true };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      const isLastAttempt = attempt >= maxAttempts - 1;
      if (isLastAttempt || !isTransientCronError(lastError)) break;
      const waitMs = BACKGROUND_RUN_RETRY_DELAYS_MS[attempt];
      logger.info(
        `[cron-supervisor] background run ${id} transient failure (attempt ${attempt + 1}/${maxAttempts}), retrying in ${Math.round(waitMs / 1000)}s: ${lastError}`,
      );
      await delay(waitMs);
    }
  }
  return { ok: false, error: lastError };
}

/** Fire a job without surfacing errors (background supervisor context). */
async function fireQuietly(id: string, context: string): Promise<void> {
  const result = await runCronJobInBackground(id);
  if (result.ok) {
    logger.info(`[cron-supervisor] ${context} run completed for job ${id}`);
  } else {
    logger.warn(`[cron-supervisor] ${context} run for job ${id} did not confirm: ${result.error || 'unknown'}`);
  }
}

/** Returns true when a catch-up run was fired for this job. */
async function maybeCatchUp(job: SupervisedCronJob, now: number): Promise<boolean> {
  const prev = previousScheduleOccurrenceMs(job.schedule, now);
  if (prev == null) return false;
  if (prev <= (job.createdAtMs ?? 0)) return false; // never run before creation
  if (now - prev < CATCHUP_MIN_OVERDUE_MS) return false; // let gateway fire it
  if (now - prev > CATCHUP_MAX_AGE_MS) return false; // too old to resurrect

  const interval = inferScheduleIntervalMs(job.schedule, now);
  if (interval == null || interval < CATCHUP_SPARSE_MIN_INTERVAL_MS) return false;

  const lastRun = job.state?.lastRunAtMs ?? 0;
  if (lastRun >= prev) return false; // gateway already ran this occurrence
  if (state.handled[job.id] === prev) return false; // we already fired it

  // Record before awaiting so an overlapping pass cannot double-fire.
  state.handled[job.id] = prev;
  await persistState();

  logger.info(
    `[cron-supervisor] catch-up firing job ${job.id} for missed occurrence ${new Date(prev).toISOString()}`,
  );
  await fireQuietly(job.id, 'catch-up');
  return true;
}

async function maybeRetryFailure(job: SupervisedCronJob, now: number): Promise<void> {
  const lastRun = job.state?.lastRunAtMs ?? 0;
  if (!lastRun) return;
  if (job.state?.lastStatus !== 'error') return;
  if (!isTransientCronError(job.state?.lastError)) return;

  // Only retry recent failures, and rate-limit to once per job per hour so a
  // permanently-failing job can never spin.
  if (now - lastRun > RETRY_FRESH_WINDOW_MS) return;
  const lastRetryAt = state.retried[job.id] ?? 0;
  if (now - lastRetryAt < RETRY_MIN_INTERVAL_MS) return;

  state.retried[job.id] = now;
  await persistState();

  logger.info(
    `[cron-supervisor] retrying transient-failed job ${job.id}: ${job.state?.lastError ?? ''}`,
  );
  await fireQuietly(job.id, 'retry');
}

async function runPass(reason: string): Promise<void> {
  if (!gateway) return;
  if (passInFlight) {
    passQueued = true;
    return;
  }
  if (gateway.getStatus().state !== 'running') return;

  passInFlight = true;
  try {
    await loadState();

    let jobs: SupervisedCronJob[] = [];
    try {
      const result = await gateway.rpc<unknown>(
        'cron.list',
        { includeDisabled: true },
        CRON_LIST_TIMEOUT_MS,
      );
      if (Array.isArray(result)) {
        jobs = result as SupervisedCronJob[];
      } else if (result && typeof result === 'object' && Array.isArray((result as { jobs?: unknown }).jobs)) {
        jobs = (result as { jobs: SupervisedCronJob[] }).jobs;
      }
    } catch {
      return; // gateway busy/unavailable; try again next pass
    }

    const now = Date.now();
    for (const job of jobs) {
      if (!job || !job.id || job.enabled === false) continue;
      // Only supervise agent-turn jobs (the kind the app schedules).
      if (job.payload?.kind && job.payload.kind !== 'agentTurn') continue;

      try {
        const firedCatchUp = await maybeCatchUp(job, now);
        if (!firedCatchUp) {
          await maybeRetryFailure(job, now);
        }
      } catch (error) {
        logger.warn(`[cron-supervisor] pass error for job ${job.id}:`, error);
      }
    }
  } catch (error) {
    logger.warn(`[cron-supervisor] pass (${reason}) failed:`, error);
  } finally {
    passInFlight = false;
    lastPassCompletedAt = Date.now();
    if (passQueued) {
      passQueued = false;
      setTimeout(() => {
        void runPass('queued');
      }, 2_000);
    }
  }
}

function clearPendingPassTimer(): void {
  if (pendingPassTimer) {
    clearTimeout(pendingPassTimer);
    pendingPassTimer = null;
  }
  pendingPassReason = null;
}

/**
 * Schedule a supervisor pass soon (e.g. after system resume or screen unlock).
 * Coalesces rapid events and skips when a pass just completed. Does not replace
 * the periodic safety-net pass.
 */
export function requestCronSupervisorPass(reason: string): void {
  if (!started || !gateway) return;

  const now = Date.now();
  if (now - lastPassCompletedAt < MIN_WAKE_PASS_INTERVAL_MS && !pendingPassTimer) {
    return;
  }

  pendingPassReason = reason;
  if (pendingPassTimer) {
    clearTimeout(pendingPassTimer);
  }

  pendingPassTimer = setTimeout(() => {
    pendingPassTimer = null;
    const passReason = pendingPassReason ?? reason;
    pendingPassReason = null;
    logger.info(`[cron-supervisor] wake-triggered pass (${passReason})`);
    void runPass(passReason);
  }, REQUEST_PASS_DELAY_MS);
  unref(pendingPassTimer);
}

/** Register OS wake hooks once (resume / unlock-screen). */
export function registerCronSupervisorWakeHooks(): void {
  if (wakeHooksRegistered) return;
  wakeHooksRegistered = true;

  powerMonitor.on('resume', () => {
    logger.info('[cron-supervisor] system resume detected');
    requestCronSupervisorPass('system-resume');
  });
  powerMonitor.on('unlock-screen', () => {
    logger.info('[cron-supervisor] screen unlock detected');
    requestCronSupervisorPass('unlock-screen');
  });
}

/** Start the cron supervisor. Idempotent — safe to call on every gateway start. */
export function startCronSupervisor(gw: GatewayLike): void {
  if (started) return;
  started = true;
  gateway = gw;

  registerCronSupervisorWakeHooks();

  initialTimer = setTimeout(() => {
    void runPass('startup-catchup');
  }, INITIAL_PASS_DELAY_MS);
  unref(initialTimer);

  periodicTimer = setInterval(() => {
    void runPass('periodic');
  }, PERIODIC_PASS_INTERVAL_MS);
  unref(periodicTimer);

  logger.info('[cron-supervisor] started (catch-up + transient-failure retry + wake triggers)');
}

/** Stop the cron supervisor and clear timers. */
export function stopCronSupervisor(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (periodicTimer) {
    clearInterval(periodicTimer);
    periodicTimer = null;
  }
  clearPendingPassTimer();
  passQueued = false;
  started = false;
  gateway = null;
}
