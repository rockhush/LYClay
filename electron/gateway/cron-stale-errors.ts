/**
 * Helpers for clearing stale delivery errors on UI "in-app only" cron jobs.
 * These errors linger after delivery config is fixed (mode: none) but the
 * Gateway still reports lastStatus=error from an earlier failed external send.
 */

export function isStaleInAppDeliveryError(error: string | undefined | null): boolean {
  const staleError = (error ?? '').trim();
  if (!staleError) return false;
  return (
    staleError.includes('Channel is required')
    || /requires\s+--to/i.test(staleError)
    || /conversationId/i.test(staleError)
    || /^message failed\.?$/i.test(staleError)
    || /^delivery failed\b/i.test(staleError)
  );
}

export interface CronJobDeliveryStateLike {
  sessionTarget?: string;
  payload?: { kind?: string };
  delivery?: { mode?: string };
  state?: { lastError?: string; lastStatus?: string };
}

export function isUiInAppCronJob(job: CronJobDeliveryStateLike): boolean {
  return (
    (job.sessionTarget === 'isolated' || !job.sessionTarget)
    && job.payload?.kind === 'agentTurn'
    && job.delivery?.mode === 'none'
  );
}

/** UI-created isolated agentTurn jobs managed by the LYClaw streaming supervisor. */
export function isUiManagedCronJob(job: CronJobDeliveryStateLike): boolean {
  return (
    (job.sessionTarget === 'isolated' || !job.sessionTarget)
    && job.payload?.kind === 'agentTurn'
  );
}

/** External-channel UI cron jobs (e.g. DingTalk announce delivery). */
export function isUiExternalChannelCronJob(job: CronJobDeliveryStateLike): boolean {
  return isUiManagedCronJob(job) && job.delivery?.mode != null && job.delivery.mode !== 'none';
}

/** Optimistically clear a stale in-app delivery error on the job object. */
export function clearStaleInAppDeliveryErrorState(job: CronJobDeliveryStateLike): boolean {
  if (!job.state?.lastError || !isStaleInAppDeliveryError(job.state.lastError)) return false;
  if (!isUiInAppCronJob(job)) return false;
  job.state.lastError = undefined;
  job.state.lastStatus = 'ok';
  return true;
}
