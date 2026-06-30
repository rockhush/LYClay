import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'http';
import { join } from 'node:path';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';
import { getOpenClawConfigDir } from '../../utils/paths';
import { resolveAccountIdFromSessionHistory } from '../../utils/session-util';
import { toOpenClawChannelType, toUiChannelType } from '../../utils/channel-alias';
import { resolveAgentIdFromChannel } from '../../utils/agent-config';
import {
  triggerCronJobStreaming,
  requestCronSupervisorPass,
  emitCronJobsUpdated,
  setManagedCronJobEnabled,
  removeManagedCronJobState,
  resolveManagedCronJobEnabled,
} from '../../gateway/cron-supervisor';
import { clearStaleInAppDeliveryErrorState, isUiInAppCronJob } from '../../gateway/cron-stale-errors';
import {
  readCronRunLog,
  resolveInAppCronLastRun,
} from '../../gateway/cron-run-log';
import {
  buildCronSessionHistoryMessages,
  buildSessionFileIndex,
} from '../../gateway/cron-session-history';

/**
 * Find agentId from session history by delivery "to" address.
 * Efficiently searches only agent session directories for matching deliveryContext.to.
 */
interface GatewayCronJob {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  schedule: { kind: string; expr?: string; everyMs?: number; at?: string; tz?: string };
  payload: { kind: string; message?: string; text?: string };
  delivery?: { mode: string; channel?: string; to?: string; accountId?: string };
  sessionTarget?: string;
  state: {
    nextRunAtMs?: number;
    runningAtMs?: number;
    lastRunAtMs?: number;
    lastStatus?: string;
    lastError?: string;
    lastDurationMs?: number;
  };
}

interface CronSessionKeyParts {
  agentId: string;
  jobId: string;
  runSessionId?: string;
}

function parseCronSessionKey(sessionKey: string): CronSessionKeyParts | null {
  if (!sessionKey.startsWith('agent:')) return null;
  const parts = sessionKey.split(':');
  if (parts.length < 4) return null;

  const agentId = parts[1] || 'main';
  const namespace = parts[2];

  if ((namespace === 'scheduled-task' || namespace === 'cron-run') && parts.length >= 5) {
    const jobId = parts[3];
    const runSessionId = parts[4];
    if (!jobId || !runSessionId) return null;
    return { agentId, jobId, runSessionId };
  }

  if (namespace !== 'cron') return null;

  const jobId = parts[3];
  if (!jobId) return null;

  if (parts.length === 4) {
    return { agentId, jobId };
  }

  if (parts.length === 6 && parts[4] === 'run' && parts[5]) {
    return { agentId, jobId, runSessionId: parts[5] };
  }

  return null;
}

function normalizeTimestampMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

async function readSessionStoreEntry(
  agentId: string,
  sessionKey: string,
): Promise<Record<string, unknown> | undefined> {
  const storePath = join(getOpenClawConfigDir(), 'agents', agentId, 'sessions', 'sessions.json');
  const raw = await readFile(storePath, 'utf8').catch(() => '');
  if (!raw.trim()) return undefined;

  try {
    const store = JSON.parse(raw) as Record<string, unknown>;
    const directEntry = store[sessionKey];
    if (directEntry && typeof directEntry === 'object') {
      return directEntry as Record<string, unknown>;
    }

    const sessions = (store as { sessions?: unknown }).sessions;
    if (Array.isArray(sessions)) {
      const arrayEntry = sessions.find((entry) => {
        if (!entry || typeof entry !== 'object') return false;
        const record = entry as Record<string, unknown>;
        return record.key === sessionKey || record.sessionKey === sessionKey;
      });
      if (arrayEntry && typeof arrayEntry === 'object') {
        return arrayEntry as Record<string, unknown>;
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}

type JsonRecord = Record<string, unknown>;
type GatewayCronDelivery = NonNullable<GatewayCronJob['delivery']>;

function getUnsupportedCronDeliveryError(_channel: string | undefined): string | null {
  // Channel support is gated by the frontend whitelist (TESTED_CRON_DELIVERY_CHANNELS).
  // No per-channel backend blocks are needed.
  return null;
}

function normalizeCronDelivery(
  rawDelivery: unknown,
  fallbackMode: GatewayCronDelivery['mode'] = 'none',
): GatewayCronDelivery {
  if (!rawDelivery || typeof rawDelivery !== 'object') {
    return { mode: fallbackMode };
  }

  const delivery = rawDelivery as JsonRecord;
  const mode = typeof delivery.mode === 'string' && delivery.mode.trim()
    ? delivery.mode.trim()
    : fallbackMode;
  const channel = typeof delivery.channel === 'string' && delivery.channel.trim()
    ? toOpenClawChannelType(delivery.channel.trim())
    : undefined;
  const to = typeof delivery.to === 'string' && delivery.to.trim()
    ? delivery.to.trim()
    : undefined;
  const accountId = typeof delivery.accountId === 'string' && delivery.accountId.trim()
    ? delivery.accountId.trim()
    : undefined;

  // "仅在 LYClaw 内" (mode none): results are delivered to the user via the
  // in-app chat. Strip any channel/to/accountId so a stale external target can
  // never make the Gateway attempt channel delivery (e.g. DingTalk requires --to).
  if (mode === 'none') {
    return { mode: 'none' };
  }

  if (mode === 'announce' && !channel) {
    return { mode: 'none' };
  }

  return {
    mode,
    ...(channel ? { channel } : {}),
    ...(to ? { to } : {}),
    ...(accountId ? { accountId } : {}),
  };
}

function normalizeCronDeliveryPatch(rawDelivery: unknown): Record<string, unknown> {
  if (!rawDelivery || typeof rawDelivery !== 'object') {
    return {};
  }

  const delivery = rawDelivery as JsonRecord;
  const patch: Record<string, unknown> = {};
  if ('mode' in delivery) {
    patch.mode = typeof delivery.mode === 'string' && delivery.mode.trim()
      ? delivery.mode.trim()
      : 'none';
  }

  // Switching to "仅在 LYClaw 内" (mode none) must clear any previously-set
  // external target, otherwise the Gateway keeps a stale channel/to and still
  // attempts channel delivery (e.g. DingTalk requires --to).
  // We omit channel/to/accountId rather than setting them to "" because the
  // Gateway rejects empty-string channel in cron.update validation.
  // The Gateway is responsible for clearing stale external targets when mode
  // transitions to "none".
  if (patch.mode === 'none') {
    return patch;
  }

  if ('channel' in delivery) {
    patch.channel = typeof delivery.channel === 'string' && delivery.channel.trim()
      ? toOpenClawChannelType(delivery.channel.trim())
      : '';
  }
  if ('to' in delivery) {
    patch.to = typeof delivery.to === 'string' ? delivery.to : '';
  }
  if ('accountId' in delivery) {
    patch.accountId = typeof delivery.accountId === 'string' ? delivery.accountId : '';
  }
  return patch;
}

function buildCronUpdatePatch(input: Record<string, unknown>): Record<string, unknown> {
  const patch = { ...input };

  if (typeof patch.schedule === 'string') {
    patch.schedule = { kind: 'cron', expr: patch.schedule, tz: Intl.DateTimeFormat().resolvedOptions().timeZone };
  }

  if (typeof patch.message === 'string') {
    patch.payload = { kind: 'agentTurn', message: patch.message };
    patch.sessionTarget = 'isolated';
    delete patch.message;
  }

  if ('delivery' in patch) {
    patch.delivery = normalizeCronDeliveryPatch(patch.delivery);
  }

  if ('agentId' in patch) {
    const agentId = typeof patch.agentId === 'string' && patch.agentId.trim()
      ? patch.agentId.trim()
      : 'main';
    patch.agentId = agentId;
    patch.sessionTarget = 'isolated';
  }

  return patch;
}

function transformCronJob(
  job: GatewayCronJob,
  lastRunOverride?: ReturnType<typeof resolveInAppCronLastRun>,
  enabledOverride?: boolean,
) {
  const message = job.payload?.message || job.payload?.text || '';
  const gatewayDelivery = normalizeCronDelivery(job.delivery);
  const channelType = gatewayDelivery.channel ? toUiChannelType(gatewayDelivery.channel) : undefined;
  const delivery = channelType
    ? { ...gatewayDelivery, channel: channelType }
    : gatewayDelivery;
  const target = channelType
    ? {
      channelType,
      channelId: delivery.accountId || gatewayDelivery.channel,
      channelName: channelType,
      recipient: delivery.to,
    }
    : undefined;
  const lastRun = lastRunOverride ?? (job.state?.lastRunAtMs
    ? {
      time: new Date(job.state.lastRunAtMs).toISOString(),
      success: job.state.lastStatus === 'ok',
      error: job.state.lastError,
      duration: job.state.lastDurationMs,
    }
    : undefined);
  const nextRun = job.state?.nextRunAtMs
    ? new Date(job.state.nextRunAtMs).toISOString()
    : undefined;

  // Parse agentId from the job's agentId field
  const agentId = (job as unknown as { agentId?: string }).agentId || 'main';

  return {
    id: job.id,
    name: job.name,
    message,
    schedule: job.schedule,
    delivery,
    target,
    enabled: enabledOverride ?? job.enabled,
    createdAt: new Date(job.createdAtMs).toISOString(),
    updatedAt: new Date(job.updatedAtMs).toISOString(),
    lastRun,
    nextRun,
    agentId,
  };
}

async function enrichCronJobsForResponse(jobs: GatewayCronJob[]): Promise<ReturnType<typeof transformCronJob>[]> {
  return Promise.all(jobs.map(async (job) => {
    const inAppJob = isUiInAppCronJob(job);
    const runs = inAppJob ? await readCronRunLog(job.id) : [];
    const lastRun = resolveInAppCronLastRun(job, runs);
    const enabledOverride = inAppJob ? await resolveManagedCronJobEnabled(job) : undefined;
    return transformCronJob(job, lastRun, enabledOverride);
  }));
}

async function findCronJobById(ctx: HostApiContext, id: string): Promise<GatewayCronJob | undefined> {
  const result = await ctx.gatewayManager.rpc('cron.list', { includeDisabled: true }, 8000);
  const jobs = (result as { jobs?: GatewayCronJob[] }).jobs ?? (Array.isArray(result) ? result as GatewayCronJob[] : []);
  return jobs.find((job) => job.id === id);
}

export async function handleCronRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: HostApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/cron/session-history' && req.method === 'GET') {
    const sessionKey = url.searchParams.get('sessionKey')?.trim() || '';
    const parsedSession = parseCronSessionKey(sessionKey);
    if (!parsedSession) {
      sendJson(res, 400, { success: false, error: `Invalid cron sessionKey: ${sessionKey}` });
      return true;
    }

    const rawLimit = Number(url.searchParams.get('limit') || '200');
    const limit = Number.isFinite(rawLimit)
      ? Math.min(Math.max(Math.floor(rawLimit), 1), 200)
      : 200;

    try {
      const [jobsResult, runs, sessionEntry] = await Promise.all([
        ctx.gatewayManager.rpc('cron.list', { includeDisabled: true }, 8000)
          .catch(() => ({ jobs: [] as GatewayCronJob[] })),
        readCronRunLog(parsedSession.jobId),
        readSessionStoreEntry(parsedSession.agentId, sessionKey),
      ]);

      const jobs = (jobsResult as { jobs?: GatewayCronJob[] }).jobs ?? [];
      const job = jobs.find((item) => item.id === parsedSession.jobId);
      const sessionsDir = join(getOpenClawConfigDir(), 'agents', parsedSession.agentId, 'sessions');
      const filesBySessionKey = await buildSessionFileIndex(join(sessionsDir, 'sessions.json'));
      const messages = await buildCronSessionHistoryMessages({
        agentId: parsedSession.agentId,
        jobId: parsedSession.jobId,
        sessionKey,
        job,
        runs,
        sessionEntry: sessionEntry ? {
          label: typeof sessionEntry.label === 'string' ? sessionEntry.label : undefined,
          updatedAt: normalizeTimestampMs(sessionEntry.updatedAt),
        } : undefined,
        sessionsDir,
        filesBySessionKey,
        limit,
      });

      sendJson(res, 200, { messages });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/cron/jobs' && req.method === 'GET') {
    try {
      let jobs: GatewayCronJob[] = [];
      let usedFallback = false;

      try {
        // 8s timeout — fail fast when Gateway is busy with AI tasks.
        const result = await ctx.gatewayManager.rpc('cron.list', { includeDisabled: true }, 8000);
        const data = result as { jobs?: GatewayCronJob[] };
        jobs = data?.jobs ?? (Array.isArray(result) ? result as GatewayCronJob[] : []);

        // DEBUG: log name and agentId for each job
        console.debug('Fetched cron jobs from Gateway:');
        for (const job of jobs) {
          const jobAgentId = (job as unknown as { agentId?: string }).agentId;
          const deliveryInfo = job.delivery ? `delivery={mode:${job.delivery.mode}, channel:${job.delivery.channel || '(none)'}, accountId:${job.delivery.accountId || '(none)'}, to:${job.delivery.to || '(none)'}}` : 'delivery=(none)';
          console.debug(`  - name: "${job.name}", agentId: "${jobAgentId || '(undefined)'}", ${deliveryInfo}, sessionTarget: "${job.sessionTarget || '(none)'}", payload.kind: "${job.payload?.kind || '(none)'}"`);
        }
      } catch {
        // Fallback: read cron.json directly when Gateway RPC fails/times out.
        try {
          const cronJsonPath = join(getOpenClawConfigDir(), 'cron', 'cron.json');
          const raw = await readFile(cronJsonPath, 'utf-8');
          const parsed = JSON.parse(raw);
          const fileJobs = Array.isArray(parsed) ? parsed : (parsed?.jobs ?? []);
          jobs = fileJobs as GatewayCronJob[];
          usedFallback = true;
        } catch {
          // No fallback data available either
        }
      }

      // Run repair in background — don't block the response.
      if (!usedFallback && jobs.length > 0) {
        // Repair 1: an isolated (in-app) agentTurn job is set to announce but
        // cannot actually deliver externally — either the channel is missing,
        // or a channel is set without a recipient (`to`). Both happen to
        // UI-created "仅在 LYClaw 内" jobs whose delivery got mangled; reverting
        // to { mode: 'none' } delivers the result to the user in-app instead of
        // failing (e.g. "DingTalk message requires --to <conversationId>").
        const jobsToRepairDelivery = jobs.filter((job) => {
          const isIsolatedAgent =
            (job.sessionTarget === 'isolated' || !job.sessionTarget) &&
            job.payload?.kind === 'agentTurn';
          if (!isIsolatedAgent || job.delivery?.mode !== 'announce') return false;
          const hasChannel = Boolean(job.delivery?.channel);
          const hasRecipient = Boolean(job.delivery?.to);
          return !hasChannel || !hasRecipient;
        });
        if (jobsToRepairDelivery.length > 0) {
          // Fire-and-forget: repair in background
          void (async () => {
            for (const job of jobsToRepairDelivery) {
              try {
                await ctx.gatewayManager.rpc('cron.update', {
                  id: job.id,
                  // Explicitly clear the stale external target so the Gateway
                  // stops attempting channel delivery.
                  patch: { delivery: { mode: 'none' } },
                });
              } catch {
                // ignore per-job repair failure
              }
            }
          })();
          // Optimistically fix the response data
          for (const job of jobsToRepairDelivery) {
            job.delivery = { mode: 'none' };
            clearStaleInAppDeliveryErrorState(job);
          }
        }
        const repairedToNoneIds = new Set(jobsToRepairDelivery.map((job) => job.id));

        // Repair 1b: in-app jobs already on mode:none may still carry a stale
        // delivery error (e.g. "Message failed") from before the config was fixed.
        for (const job of jobs) {
          if (repairedToNoneIds.has(job.id)) continue;
          clearStaleInAppDeliveryErrorState(job);
        }

        // Repair 2: agentId is undefined for jobs with announce delivery
        // Only repair undefined -> inferred agent, NOT main -> inferred agent
        const jobsToRepairAgent = jobs.filter((job) => {
          const jobAgentId = (job as unknown as { agentId?: string }).agentId;
          return (
            !repairedToNoneIds.has(job.id) &&  // already downgraded to in-app delivery
            (job.sessionTarget === 'isolated' || !job.sessionTarget) &&
            job.payload?.kind === 'agentTurn' &&
            job.delivery?.mode === 'announce' &&
            job.delivery?.channel &&
            jobAgentId === undefined  // Only repair when agentId is completely undefined
          );
        });
        if (jobsToRepairAgent.length > 0) {
          console.debug(`Found ${jobsToRepairAgent.length} jobs needing agent repair:`);
          for (const job of jobsToRepairAgent) {
            console.debug(`  - Job "${job.name}" (id: ${job.id}): current agentId="${(job as unknown as { agentId?: string }).agentId || '(undefined)'}", channel="${job.delivery?.channel}", accountId="${job.delivery?.accountId || '(none)'}"`);
          }
          // Fire-and-forget: repair in background
          void (async () => {
            for (const job of jobsToRepairAgent) {
              try {
                const channel = toOpenClawChannelType(job.delivery!.channel!);
                const accountId = job.delivery!.accountId;
                const toAddress = job.delivery!.to;

                // Try 1: resolve from channel + accountId binding
                let correctAgentId = await resolveAgentIdFromChannel(channel, accountId);

                // If no accountId, try to resolve it from session history using "to" address, then get agentId
                let resolvedAccountId: string | null = null;
                if (!correctAgentId && !accountId && toAddress) {
                  console.debug(`No binding found for channel="${channel}", accountId="${accountId || '(none)'}", trying session history for to="${toAddress}"`);
                  resolvedAccountId = await resolveAccountIdFromSessionHistory(toAddress, channel);
                  if (resolvedAccountId) {
                    console.debug(`Resolved accountId="${resolvedAccountId}" from session history, now resolving agentId`);
                    correctAgentId = await resolveAgentIdFromChannel(channel, resolvedAccountId);
                  }
                }

                if (correctAgentId) {
                  console.debug(`Repairing job "${job.name}": agentId "${(job as unknown as { agentId?: string }).agentId || '(undefined)'}" -> "${correctAgentId}"`);
                  // When accountId was resolved via to address, include it in the patch
                  const patch: Record<string, unknown> = { agentId: correctAgentId };
                  if (resolvedAccountId && !accountId) {
                    patch.delivery = { accountId: resolvedAccountId };
                  }
                  await ctx.gatewayManager.rpc('cron.update', { id: job.id, patch });
                  // Update the local job object so response reflects correct agentId
                  (job as unknown as { agentId: string }).agentId = correctAgentId;
                  if (resolvedAccountId && !accountId && job.delivery) {
                    job.delivery.accountId = resolvedAccountId;
                  }
                } else {
                  console.warn(`Could not resolve agent for job "${job.name}": channel="${channel}", accountId="${accountId || '(none)'}", to="${toAddress || '(none)'}"`);
                }
              } catch (error) {
                console.error(`Failed to repair agent for job "${job.name}":`, error);
              }
            }
          })();
        }
      }

      sendJson(res, 200, await enrichCronJobsForResponse(jobs).then((enriched) => (
        enriched.map((job) => ({ ...job, ...(usedFallback ? { _fromFallback: true } : {}) }))
      )));
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/cron/jobs' && req.method === 'POST') {
    try {
      const input = await parseJsonBody<{
        name: string;
        message: string;
        schedule: string;
        delivery?: GatewayCronDelivery;
        enabled?: boolean;
        agentId?: string;
      }>(req);
      const agentId = typeof input.agentId === 'string' && input.agentId.trim()
        ? input.agentId.trim()
        : 'main';
      // DEBUG: log the input and resolved agentId
      console.debug(`Creating cron job: name="${input.name}", input.agentId="${input.agentId || '(not provided)'}", resolved agentId="${agentId}"`);
      const delivery = normalizeCronDelivery(input.delivery);
      const unsupportedDeliveryError = getUnsupportedCronDeliveryError(delivery.channel);
      if (delivery.mode === 'announce' && unsupportedDeliveryError) {
        sendJson(res, 400, { success: false, error: unsupportedDeliveryError });
        return true;
      }
      const managedInApp = delivery.mode === 'none';
      const managedEnabled = input.enabled ?? true;
      const result = await ctx.gatewayManager.rpc('cron.add', {
        name: input.name,
        schedule: { kind: 'cron', expr: input.schedule, tz: Intl.DateTimeFormat().resolvedOptions().timeZone },
        payload: { kind: 'agentTurn', message: input.message },
        // LYClaw-managed in-app jobs are kept disabled in OpenClaw's own
        // scheduler so they cannot fire via cron.run and bypass chat streaming.
        enabled: managedInApp ? false : managedEnabled,
        wakeMode: 'next-heartbeat',
        sessionTarget: 'isolated',
        agentId,
        delivery,
      });
      if (result && typeof result === 'object') {
        const job = result as GatewayCronJob;
        if (managedInApp) {
          await setManagedCronJobEnabled(job.id, managedEnabled);
        }
        sendJson(res, 200, transformCronJob(job, undefined, managedInApp ? managedEnabled : undefined));
      } else {
        sendJson(res, 200, result);
      }
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname.startsWith('/api/cron/jobs/') && req.method === 'PUT') {
    try {
      const id = decodeURIComponent(url.pathname.slice('/api/cron/jobs/'.length));
      const input = await parseJsonBody<Record<string, unknown>>(req);
      const patch = buildCronUpdatePatch(input);
      const deliveryPatch = patch.delivery && typeof patch.delivery === 'object'
        ? patch.delivery as Record<string, unknown>
        : undefined;
      const deliveryChannel = typeof deliveryPatch?.channel === 'string' && deliveryPatch.channel.trim()
        ? deliveryPatch.channel.trim()
        : undefined;
      const deliveryMode = typeof deliveryPatch?.mode === 'string' && deliveryPatch.mode.trim()
        ? deliveryPatch.mode.trim()
        : undefined;
      const unsupportedDeliveryError = getUnsupportedCronDeliveryError(deliveryChannel);
      if (unsupportedDeliveryError && deliveryMode !== 'none') {
        sendJson(res, 400, { success: false, error: unsupportedDeliveryError });
        return true;
      }
      const existing = await findCronJobById(ctx, id).catch(() => undefined);
      const requestedEnabled = typeof input.enabled === 'boolean' ? input.enabled : undefined;
      const existingInApp = existing ? isUiInAppCronJob(existing) : false;
      const switchingToInApp = deliveryMode === 'none';
      const switchingToExternal = Boolean(deliveryMode && deliveryMode !== 'none');

      if (switchingToInApp || existingInApp) {
        // LYClaw owns in-app execution; keep OpenClaw's own scheduler disabled
        // so only the chat.send streaming supervisor fires the task.
        patch.enabled = false;
      }
      if (switchingToExternal && existingInApp) {
        const restoredEnabled = requestedEnabled
          ?? (existing ? await resolveManagedCronJobEnabled(existing) : undefined)
          ?? existing?.enabled
          ?? true;
        patch.enabled = restoredEnabled;
        await removeManagedCronJobState(id);
      }

      const result = await ctx.gatewayManager.rpc('cron.update', { id, patch });
      if (result && typeof result === 'object') {
        const job = result as GatewayCronJob;
        const inAppJob = isUiInAppCronJob(job);
        let enabledOverride: boolean | undefined;
        if (inAppJob) {
          enabledOverride = requestedEnabled
            ?? (existing ? await resolveManagedCronJobEnabled(existing) : undefined)
            ?? existing?.enabled
            ?? true;
          await setManagedCronJobEnabled(id, enabledOverride);
        }
        sendJson(res, 200, transformCronJob(job, undefined, enabledOverride));
      } else {
        sendJson(res, 200, result);
      }
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname.startsWith('/api/cron/jobs/') && req.method === 'DELETE') {
    try {
      const id = decodeURIComponent(url.pathname.slice('/api/cron/jobs/'.length));
      const result = await ctx.gatewayManager.rpc('cron.remove', { id });
      await removeManagedCronJobState(id);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/cron/toggle' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ id: string; enabled: boolean }>(req);
      const existing = await findCronJobById(ctx, body.id).catch(() => undefined);
      if (existing && isUiInAppCronJob(existing)) {
        await setManagedCronJobEnabled(body.id, body.enabled);
        const result = await ctx.gatewayManager.rpc('cron.update', { id: body.id, patch: { enabled: false } });
        sendJson(res, 200, result && typeof result === 'object'
          ? transformCronJob(result as GatewayCronJob, undefined, body.enabled)
          : result);
      } else {
        await removeManagedCronJobState(body.id);
        sendJson(res, 200, await ctx.gatewayManager.rpc('cron.update', { id: body.id, patch: { enabled: body.enabled } }));
      }
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/cron/trigger' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ id: string }>(req);
      const result = await triggerCronJobStreaming(ctx.gatewayManager, body.id);
      emitCronJobsUpdated('manual-trigger', body.id);
      sendJson(res, 200, { success: true, id: body.id, sessionKey: result.sessionKey, runId: result.runId });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/cron/supervisor-nudge' && req.method === 'POST') {
    requestCronSupervisorPass('cron-page');
    sendJson(res, 200, { success: true });
    return true;
  }

  return false;
}
