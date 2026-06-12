/**
 * Public surface of the reporting module.
 *
 * Renderer code reaches this module exclusively through the host-api routes
 * in `electron/api/routes/usage-report.ts` — never via direct imports — so
 * we keep the module boundary in one place.
 */

import { logger } from '../logger';
import { getSetting } from '../store';
import {
  appendSkillDownloadRecord,
  appendSkillInvokeRecord,
  appendTokenConsumeRecord,
  getUsageReportQueueSnapshot,
} from './queue';
import { flushUsageReports } from './uploader';
import { formatReportDate } from './time';
import {
  hydrateWorkNoCacheFromStore,
  resolveWorkNo,
} from './work-no';

export {
  flushUsageReports,
} from './uploader';
export {
  startUsageReportScheduler,
  stopUsageReportScheduler,
} from './scheduler';
export {
  hydrateWorkNoCacheFromStore,
  ensureWorkNoReady,
} from './work-no';
export type {
  ReportingFlushResult,
  TokenConsumeRecord,
  SkillDownloadRecord,
  SkillInvokeRecord,
  UsageReportQueueSnapshot,
} from './types';

export interface RecordTokenConsumeInput {
  model: string;
  consume: number;
  /** Backend field name is `consumeTime`. `date` accepted for legacy callers. */
  consumeTime?: string | Date | number;
  date?: string | Date | number;
}

export async function recordTokenConsume(input: RecordTokenConsumeInput): Promise<void> {
  if (input.consume <= 0 || !input.model) return;
  const workNo = await resolveWorkNo();
  await appendTokenConsumeRecord({
    workNo,
    model: input.model,
    consume: input.consume,
    consumeTime: input.consumeTime ?? input.date ?? new Date(),
  });
  logger.debug(`[UsageReport] queued token-consume: ${input.model} ${input.consume}`);
}

export interface RecordSkillDownloadInput {
  skillId: string;
  count?: number;
  /** Backend field name is `downloadTime`. `date` accepted for legacy callers. */
  downloadTime?: string | Date | number;
  date?: string | Date | number;
}

export async function recordSkillDownload(input: RecordSkillDownloadInput): Promise<void> {
  if (!input.skillId) return;
  const workNo = await resolveWorkNo();
  await appendSkillDownloadRecord({
    workNo,
    skillId: input.skillId,
    count: input.count ?? 1,
    downloadTime: input.downloadTime ?? input.date ?? new Date(),
  });
  logger.debug(`[UsageReport] queued skill-download: ${input.skillId}`);
}

export interface RecordSkillInvokeInput {
  skillId: string;
  count?: number;
  /** Backend field name is `invokeTime`. `date` accepted for legacy callers. */
  invokeTime?: string | Date | number;
  date?: string | Date | number;
}

export async function recordSkillInvoke(input: RecordSkillInvokeInput): Promise<void> {
  if (!input.skillId) return;
  const workNo = await resolveWorkNo();
  await appendSkillInvokeRecord({
    workNo,
    skillId: input.skillId,
    count: input.count ?? 1,
    invokeTime: input.invokeTime ?? input.date ?? new Date(),
  });
  logger.debug(`[UsageReport] queued skill-invoke: ${input.skillId}`);
}

export async function getReportingStatus(): Promise<{
  queue: Awaited<ReturnType<typeof getUsageReportQueueSnapshot>>;
  lastUploadAt: {
    tokenConsume: string | null;
    skillDownload: string | null;
    skillInvoke: string | null;
  };
}> {
  const queue = await getUsageReportQueueSnapshot();
  const lastUploadAt = (await getSetting('usageReportLastUploadAt')) ?? {
    tokenConsume: null,
    skillDownload: null,
    skillInvoke: null,
  };
  return { queue, lastUploadAt };
}

/** Re-export pure helper for renderer-side date formatting via host-api round-trip. */
export { formatReportDate };

/** Re-exported queue snapshot reader for the diagnostics route. */
export { getUsageReportQueueSnapshot };

/** Trigger a flush from main-process callers (e.g. on home entry). */
export async function flushOnHomeEntry(): Promise<void> {
  try {
    await flushUsageReports('home-entry');
  } catch (error) {
    logger.warn('[UsageReport] home-entry flush threw:', error);
  }
}
