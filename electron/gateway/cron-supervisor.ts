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
 * LYClaw in-app cron jobs are executed through `chat.send`, not `cron.run`, so
 * every manual, scheduled, catch-up, or retry execution gets a fresh chat
 * session and streams through the normal chat websocket path.
 */

import { powerMonitor } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger';
import { getOpenClawConfigDir } from '../utils/paths';
import {
  buildChannelMessageTargetSystemPrompt,
  mergeExtraSystemPrompt,
  type SessionDeliveryContext,
  upsertSessionDeliveryContext,
} from '../utils/session-delivery-context';
import {
  inferScheduleIntervalMs,
  isTransientCronError,
  previousScheduleOccurrenceMs,
  type GatewayCronScheduleLike,
} from './cron-schedule';
import { isUiInAppCronJob } from './cron-stale-errors';
import { appendCronRunLogEntry, readCronRunLog, resolveEffectiveLastRunAtMs } from './cron-run-log';

export type CronJobsUpdatedReason = 'supervisor-scheduled' | 'supervisor-catch-up' | 'supervisor-retry' | 'gateway-scheduled' | 'manual-trigger';

export type CronJobsUpdatedPayload = {
  reason: CronJobsUpdatedReason;
  jobId: string;
};

type CronJobsUpdatedHandler = (payload: CronJobsUpdatedPayload) => void;

let onCronJobsUpdated: CronJobsUpdatedHandler | null = null;

/** Register a handler to notify the UI when a background supervisor run succeeds. */
export function setCronJobsUpdatedHandler(handler: CronJobsUpdatedHandler | null): void {
  onCronJobsUpdated = handler;
}

/** Notify renderer listeners that cron job state should be refreshed. */
export function emitCronJobsUpdated(reason: CronJobsUpdatedReason, jobId: string): void {
  notifyCronJobsUpdated(reason, jobId);
}

function notifyCronJobsUpdated(reason: CronJobsUpdatedReason, jobId: string): void {
  try {
    onCronJobsUpdated?.({ reason, jobId });
  } catch {
    // ignore notifier failures
  }
}

interface GatewayLike {
  getStatus: () => { state: string; warmupStatus?: 'idle' | 'warming' | 'ready' | 'failed' };
  rpc: <T>(method: string, params?: unknown, timeoutMs?: number) => Promise<T>;
}

interface SupervisedCronJob {
  id: string;
  name?: string;
  agentId?: string;
  enabled?: boolean;
  createdAtMs?: number;
  schedule?: GatewayCronScheduleLike;
  payload?: { kind?: string; message?: string; text?: string };
  delivery?: { mode?: string; channel?: string; to?: string; accountId?: string };
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
  /** Occurrence (ms) LYClaw streaming scheduler already accepted, keyed by job id. */
  scheduledHandled: Record<string, number>;
  /** LYClaw-managed in-app cron enabled state, keyed by job id. */
  managed: Record<string, { enabled: boolean }>;
  /** Last time (ms) we auto-retried a failed run, keyed by job id. */
  retried: Record<string, number>;
}

const STATE_FILE = join(getOpenClawConfigDir(), 'cron', '.lyclaw-cron-supervisor.json');

// Defer the first pass so the gateway can finish warmup and run its own on-time
// / catch-up firing before we step in. We only act on what it missed/failed.
const INITIAL_PASS_DELAY_MS = 90_000;
// Frequent scheduler pass: LYClaw owns in-app cron execution so this is the
// actual due-time detector for jobs that must stream through chat.send.
const PERIODIC_PASS_INTERVAL_MS = 15_000;
// Lightweight poll so the UI reflects gateway on-time runs without waiting for app restart.
const UI_STATE_POLL_INTERVAL_MS = 15_000;
// Brief settle after resume/unlock so the gateway websocket can recover before chat.send.
const REQUEST_PASS_DELAY_MS = 5_000;
// Skip redundant wake-triggered passes when a pass just completed (periodic still runs on schedule).
const MIN_WAKE_PASS_INTERVAL_MS = 45_000;

// Background (catch-up / retry) runs are fire-and-forget and never block the
// UI, so they can afford a patient timeout.
const CRON_RUN_TIMEOUT_MS = 180_000;
const CRON_LIST_TIMEOUT_MS = 8_000;

// Manual "立即运行" runs block the UI button, so keep the wait short.
const MANUAL_RUN_TIMEOUT_MS = 45_000;

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
let state: SupervisorState = { handled: {}, scheduledHandled: {}, managed: {}, retried: {} };
let stateLoaded = false;
let uiStatePollTimer: ReturnType<typeof setInterval> | null = null;
let uiWatchInitialized = false;
let lastKnownRunAtMs: Record<string, number> = {};

/** Detect jobs whose lastRunAtMs advanced since the previous UI poll. */
export function detectCronJobRunUpdates(
  previousRunAtMs: Record<string, number>,
  jobs: Array<Pick<SupervisedCronJob, 'id' | 'state'>>,
  initialized: boolean,
): { nextRunAtMs: Record<string, number>; updatedJobIds: string[]; initialized: boolean } {
  const nextRunAtMs: Record<string, number> = { ...previousRunAtMs };
  const updatedJobIds: string[] = [];

  for (const job of jobs) {
    if (!job?.id) continue;
    const current = job.state?.lastRunAtMs ?? 0;
    if (!initialized) {
      nextRunAtMs[job.id] = current;
      continue;
    }
    const prev = nextRunAtMs[job.id] ?? 0;
    if (current > prev) {
      updatedJobIds.push(job.id);
    }
    nextRunAtMs[job.id] = current;
  }

  return {
    nextRunAtMs,
    updatedJobIds,
    initialized: true,
  };
}

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
      scheduledHandled: parsed.scheduledHandled && typeof parsed.scheduledHandled === 'object' ? parsed.scheduledHandled : {},
      managed: parsed.managed && typeof parsed.managed === 'object' ? parsed.managed : {},
      retried: parsed.retried && typeof parsed.retried === 'object' ? parsed.retried : {},
    };
  } catch {
    state = { handled: {}, scheduledHandled: {}, managed: {}, retried: {} };
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
 * Resolved cron job info needed to fire a run via chat.send.
 */
interface ResolvedCronJobInfo {
  agentId: string;
  message: string;
  name?: string;
  deliveryMode: string;
  deliveryContext?: SessionDeliveryContext;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

class CronDeliveryConfigError extends Error {}

function resolveCronDeliveryContext(job: Record<string, unknown>): {
  deliveryMode: string;
  deliveryContext?: SessionDeliveryContext;
} {
  const delivery = job.delivery && typeof job.delivery === 'object'
    ? job.delivery as Record<string, unknown>
    : undefined;
  const deliveryMode = readNonEmptyString(delivery?.mode) ?? 'none';
  if (deliveryMode === 'none') {
    return { deliveryMode };
  }

  const channel = readNonEmptyString(delivery?.channel);
  const to = readNonEmptyString(delivery?.to);
  if (!channel || !to) {
    throw new CronDeliveryConfigError(`cron job ${String(job.id ?? '(unknown)')} delivery.${!channel ? 'channel' : 'to'} is required for ${deliveryMode} delivery`);
  }

  const accountId = readNonEmptyString(delivery?.accountId);
  return {
    deliveryMode,
    deliveryContext: {
      channel,
      to,
      ...(accountId ? { accountId } : {}),
    },
  };
}

async function resolveCronJobInfo(jobId: string): Promise<ResolvedCronJobInfo> {
  let agentId = 'main';
  let message = 'Scheduled task';
  let name: string | undefined;
  let deliveryMode = 'none';
  let deliveryContext: SessionDeliveryContext | undefined;
  try {
    const result = await gateway!.rpc<unknown>('cron.list', { includeDisabled: true }, 8000);
    const jobs: Array<Record<string, unknown>> = Array.isArray(result)
      ? (result as Array<Record<string, unknown>>)
      : ((result as { jobs?: Array<Record<string, unknown>> })?.jobs ?? []);
    const job = jobs.find((j) => j.id === jobId);
    if (job) {
      agentId = (typeof job.agentId === 'string' && job.agentId.trim()) ? job.agentId : agentId;
      if (typeof job.name === 'string' && job.name.trim()) {
        name = job.name.trim();
      }
      const payload = job.payload as Record<string, unknown> | undefined;
      if (payload) {
        message = (typeof payload.message === 'string' && payload.message.trim())
          ? payload.message
          : (typeof payload.text === 'string' && payload.text.trim())
            ? payload.text
            : message;
      }
      if (name && message === 'Scheduled task') {
        message = name;
      }
      const delivery = resolveCronDeliveryContext(job);
      deliveryMode = delivery.deliveryMode;
      deliveryContext = delivery.deliveryContext;
    }
  } catch (error) {
    if (error instanceof CronDeliveryConfigError) {
      throw error;
    }
    // If cron.list fails, proceed with defaults — chat.send will still work.
  }
  return { agentId, message, name, deliveryMode, deliveryContext };
}

export async function setManagedCronJobEnabled(jobId: string, enabled: boolean): Promise<void> {
  await loadState();
  state.managed[jobId] = { enabled };
  await persistState();
}

export async function removeManagedCronJobState(jobId: string): Promise<void> {
  await loadState();
  delete state.managed[jobId];
  delete state.scheduledHandled[jobId];
  delete state.handled[jobId];
  delete state.retried[jobId];
  await persistState();
}

export async function resolveManagedCronJobEnabled(job: Pick<SupervisedCronJob, 'id' | 'enabled'>): Promise<boolean | undefined> {
  await loadState();
  return state.managed[job.id]?.enabled ?? job.enabled;
}

async function shouldRunManagedInAppCronJob(job: SupervisedCronJob, now: number): Promise<{ dueAtMs: number } | null> {
  if (!isUiInAppCronJob(job)) return null;
  const enabled = await resolveManagedCronJobEnabled(job);
  if (enabled === false) return null;

  const dueAtMs = previousScheduleOccurrenceMs(job.schedule, now);
  if (dueAtMs == null) return null;
  if (dueAtMs <= (job.createdAtMs ?? 0)) return null;
  if (dueAtMs > now) return null;
  if (now - dueAtMs > CATCHUP_MAX_AGE_MS) return null;

  const lastRun = resolveEffectiveLastRunAtMs(job, await readCronRunLog(job.id));
  if (lastRun >= dueAtMs) return null;
  if (state.scheduledHandled[job.id] === dueAtMs) return null;

  return { dueAtMs };
}

async function maybeRunManagedInAppCronJob(job: SupervisedCronJob, now: number): Promise<boolean> {
  const due = await shouldRunManagedInAppCronJob(job, now);
  if (!due) return false;

  state.scheduledHandled[job.id] = due.dueAtMs;
  await persistState();

  logger.info(
    `[cron-supervisor] scheduled streaming run firing job ${job.id} for occurrence ${new Date(due.dueAtMs).toISOString()}`,
  );
  const ok = await fireQuietly(job.id, 'supervisor-scheduled');
  if (!ok) {
    delete state.scheduledHandled[job.id];
    await persistState();
  }
  return ok;
}

/**
 * Fire a cron job run via chat.send into a fresh scheduled-task session.
 * Returns { sessionKey, runId } after the run has been accepted; streaming
 * continues through the normal Gateway chat websocket path.
 */
async function fireCronJobViaChatSend(
  info: ResolvedCronJobInfo,
  jobId: string,
  timeoutMs: number,
  source: CronJobsUpdatedReason,
): Promise<{ sessionKey: string; runId: string }> {
  // Do not use :cron: / :cron-run: here: OpenClaw treats those as cron aggregate
  // sessions and can merge repeated runs. scheduled-task is still recognizable
  // by LYClaw, but the Gateway handles it as a fresh ordinary chat session.
  const runSessionId = randomUUID();
  const sessionId = `scheduled-task:${jobId}:${runSessionId}`;
  const sessionKey = `agent:${info.agentId}:${sessionId}`;
  const idempotencyKey = `scheduled-task-${jobId}-${runSessionId}`;
  const startedAt = Date.now();
  const deliveryPrompt = info.deliveryContext
    ? buildChannelMessageTargetSystemPrompt(info.deliveryContext)
    : undefined;

  if (info.deliveryContext) {
    await upsertSessionDeliveryContext(sessionKey, info.deliveryContext);
  }

  const chatResult = await gateway!.rpc<{ runId?: string }>('chat.send', {
    sessionKey,
    sessionId,
    message: info.message,
    deliver: info.deliveryMode !== 'none',
    ...(deliveryPrompt ? { extraSystemPrompt: mergeExtraSystemPrompt(undefined, deliveryPrompt) } : {}),
    idempotencyKey,
  }, timeoutMs);

  const runId = chatResult?.runId;
  if (!runId) {
    throw new Error('chat.send did not return runId for cron trigger');
  }

  await appendCronRunLogEntry(jobId, {
    status: 'ok',
    summary: 'Scheduled task accepted; streaming output is available in the chat session.',
    sessionId: runSessionId,
    sessionKey,
    runId,
    source,
    runAtMs: startedAt,
    durationMs: Date.now() - startedAt,
  });

  return { sessionKey, runId };
}

/**
 * Streaming manual trigger: sends the cron job message via `chat.send` to a
 * fresh scheduled-task session so the renderer receives live agent notifications
 * and can show real-time streaming output in the chat UI.
 */
export async function triggerCronJobStreaming(
  gw: GatewayLike,
  jobId: string,
): Promise<{ sessionKey: string; runId: string }> {
  gateway = gw;
  await waitForWarmupIfInProgress();
  const info = await resolveCronJobInfo(jobId);
  return fireCronJobViaChatSend(info, jobId, MANUAL_RUN_TIMEOUT_MS, 'manual-trigger');
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
 * Background executions use the same chat.send streaming path as manual runs, so
 * every attempt gets a fresh visible chat session. Never throws.
 */
async function runCronJobInBackground(id: string, source: CronJobsUpdatedReason): Promise<{ ok: boolean; error?: string }> {
  await waitForWarmupIfInProgress();

  const maxAttempts = BACKGROUND_RUN_RETRY_DELAYS_MS.length + 1;
  let lastError = '';
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (!gateway || gateway.getStatus().state !== 'running') {
      return { ok: false, error: lastError || 'gateway not running' };
    }
    try {
      const info = await resolveCronJobInfo(id);
      await fireCronJobViaChatSend(info, id, CRON_RUN_TIMEOUT_MS, source);
      return { ok: true };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      const isLastAttempt = attempt >= maxAttempts - 1;
      if (isLastAttempt || !isTransientCronError(lastError)) break;
      const waitMs = BACKGROUND_RUN_RETRY_DELAYS_MS[attempt];
      logger.info(
        `[cron-supervisor] background streaming run ${id} transient failure (attempt ${attempt + 1}/${maxAttempts}), retrying in ${Math.round(waitMs / 1000)}s: ${lastError}`,
      );
      await delay(waitMs);
    }
  }
  await appendCronRunLogEntry(id, {
    status: 'error',
    error: lastError || 'unknown background streaming run failure',
    source,
    runAtMs: Date.now(),
  }).catch(() => undefined);
  return { ok: false, error: lastError };
}

/** Fire a job without surfacing errors (background supervisor context). */
async function fireQuietly(id: string, context: CronJobsUpdatedReason): Promise<boolean> {
  const result = await runCronJobInBackground(id, context);
  if (result.ok) {
    logger.info(`[cron-supervisor] ${context} streaming run accepted for job ${id}`);
    notifyCronJobsUpdated(context, id);
    return true;
  }
  logger.warn(`[cron-supervisor] ${context} streaming run for job ${id} did not confirm: ${result.error || 'unknown'}`);
  return false;
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
  await fireQuietly(job.id, 'supervisor-catch-up');
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
  await fireQuietly(job.id, 'supervisor-retry');
}

async function pollCronUiState(): Promise<void> {
  if (!gateway || gateway.getStatus().state !== 'running') return;

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
    return;
  }

  const jobsForDetection: Array<Pick<SupervisedCronJob, 'id' | 'state'>> = [];
  for (const job of jobs) {
    if (!job?.id) continue;
    let effectiveLastRunAtMs = job.state?.lastRunAtMs ?? 0;
    if (isUiInAppCronJob(job)) {
      const runs = await readCronRunLog(job.id);
      effectiveLastRunAtMs = resolveEffectiveLastRunAtMs(job, runs);
    }
    jobsForDetection.push({
      id: job.id,
      state: {
        ...job.state,
        lastRunAtMs: effectiveLastRunAtMs,
      },
    });
  }

  const { nextRunAtMs, updatedJobIds, initialized } = detectCronJobRunUpdates(
    lastKnownRunAtMs,
    jobsForDetection,
    uiWatchInitialized,
  );
  lastKnownRunAtMs = nextRunAtMs;
  uiWatchInitialized = initialized;

  for (const jobId of updatedJobIds) {
    notifyCronJobsUpdated('gateway-scheduled', jobId);
  }
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
      if (!job || !job.id) continue;
      // Only supervise agent-turn jobs (the kind the app schedules).
      if (job.payload?.kind && job.payload.kind !== 'agentTurn') continue;
      const enabled = isUiInAppCronJob(job)
        ? await resolveManagedCronJobEnabled(job)
        : job.enabled;
      if (enabled === false) continue;

      try {
        const firedScheduled = await maybeRunManagedInAppCronJob(job, now);
        if (firedScheduled) continue;

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

  // Migrate existing in-app cron jobs: disable them in the Gateway so
  // OpenClaw's own scheduler stops firing them (cron.run), and record the
  // user's original enabled state in the LYClaw sidecar so the streaming
  // scheduler takes over.  This runs once per installation; after migration
  // the sidecar is the source of truth for in-app enabled state.
  //
  // Why this matters: before LYClaw managed in-app cron execution, every
  // scheduled run went through the Gateway's cron.run which created a
  // cron:<jobId> aggregate session (no streaming, repeated runs merged).
  // After the upgrade the streaming scheduler creates a fresh
  // scheduled-task session via chat.send for every run.  If the Gateway
  // is still also firing the same job, the user sees two concurrent runs
  // — the old cron session AND the new streaming session — for every
  // occurrence.
  void migrateExistingInAppCronJobs(gw);

  initialTimer = setTimeout(() => {
    void runPass('startup-catchup');
  }, INITIAL_PASS_DELAY_MS);
  unref(initialTimer);

  periodicTimer = setInterval(() => {
    void runPass('periodic');
  }, PERIODIC_PASS_INTERVAL_MS);
  unref(periodicTimer);

  uiStatePollTimer = setInterval(() => {
    void pollCronUiState();
  }, UI_STATE_POLL_INTERVAL_MS);
  unref(uiStatePollTimer);

  const initialUiPollTimer = setTimeout(() => {
    void pollCronUiState();
  }, 5_000);
  unref(initialUiPollTimer);

  logger.info('[cron-supervisor] started (in-app streaming scheduler + catch-up + transient-failure retry + wake triggers + UI poll)');
}

/**
 * One-time migration: for every existing in-app cron job that the Gateway
 * still owns, disable Gateway-side scheduling and record the original
 * enabled state in the LYClaw sidecar.  Idempotent — safe to call on every
 * startup; already-migrated jobs are skipped.
 *
 * Retries up to 3 times with increasing backoff because the Gateway may
 * still be initialising its cron store when the supervisor first starts.
 */
async function migrateExistingInAppCronJobs(gw: GatewayLike): Promise<void> {
  await loadState();

  const RETRY_DELAYS_MS = [5_000, 15_000, 30_000];
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    if (gw.getStatus().state !== 'running') {
      if (attempt < RETRY_DELAYS_MS.length) {
        await delay(RETRY_DELAYS_MS[attempt]!);
        continue;
      }
      return;
    }

    let jobs: Array<Record<string, unknown>> = [];
    try {
      const result = await gw.rpc<unknown>('cron.list', { includeDisabled: true }, 8000);
      jobs = Array.isArray(result)
        ? (result as Array<Record<string, unknown>>)
        : ((result as { jobs?: Array<Record<string, unknown>> })?.jobs ?? []);
    } catch (e) {
      if (attempt < RETRY_DELAYS_MS.length) {
        logger.warn(`[cron-supervisor] migration cron.list attempt ${attempt + 1} failed, retrying in ${RETRY_DELAYS_MS[attempt]! / 1000}s:`, e);
        await delay(RETRY_DELAYS_MS[attempt]!);
        continue;
      }
      logger.warn('[cron-supervisor] migration cron.list exhausted retries:', e);
      return;
    }

    let migrated = 0;
    let skipped = 0;
    for (const job of jobs) {
      if (!job?.id) continue;
      if (!isUiInAppCronJob(job as SupervisedCronJob)) continue;
      const jobId = String(job.id);
      if (state.managed[jobId]) { skipped += 1; continue; }

      // Preserve the user's original enabled preference.  `enabled` is
      // `true` when the field is absent (default for Gateway-created jobs).
      const wasEnabled = job.enabled !== false;
      state.managed[jobId] = { enabled: wasEnabled };
      await persistState(); // durable before we touch the Gateway

      if (wasEnabled) {
        try {
          await gw.rpc('cron.update', { id: job.id, patch: { enabled: false } }, 8000);
          logger.info(`[cron-supervisor] migrated in-app job ${jobId}: Gateway enabled→false, LYClaw enabled→${wasEnabled}`);
        } catch (e) {
          logger.warn(`[cron-supervisor] failed to disable Gateway cron for ${jobId}, rolling back sidecar:`, e);
          delete state.managed[jobId];
          await persistState();
          continue;
        }
      } else {
        logger.info(`[cron-supervisor] migrated in-app job ${jobId}: already disabled, LYClaw enabled→false`);
      }
      migrated += 1;
    }

    if (migrated > 0 || skipped > 0) {
      logger.info(`[cron-supervisor] migration complete: ${migrated} migrated, ${skipped} already managed`);
    }
    return;
  }
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
  if (uiStatePollTimer) {
    clearInterval(uiStatePollTimer);
    uiStatePollTimer = null;
  }
  uiWatchInitialized = false;
  lastKnownRunAtMs = {};
  passQueued = false;
  started = false;
  gateway = null;
}
