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
  appendExecutionRecord,
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
import { app } from 'electron';

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
import type {
  ExecutionRecord,
} from './types';

export type {
  ReportingFlushResult,
  TokenConsumeRecord,
  SkillDownloadRecord,
  SkillInvokeRecord,
  ExecutionRecord,
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
  create_by?: string;
  create_date?: string | Date | number;
  update_by?: string;
  update_date?: string | Date | number;
  execution_id?: string;
  agent_id?: string;
  skill_source?: string;
  invoke_mode?: SkillInvokeRecord['invoke_mode'];
  invoke_time?: string | Date | number;
  invoke_end_time?: string | Date | number;
  status?: SkillInvokeRecord['status'];
  error_message?: string;
}

export async function recordSkillInvoke(input: RecordSkillInvokeInput): Promise<void> {
  if (!input.skillId) return;
  const workNo = await resolveWorkNo();
  const auditBy = workNo.trim() || undefined;
  await appendSkillInvokeRecord({
    workNo,
    skillId: input.skillId,
    count: input.count ?? 1,
    invokeTime: input.invoke_time ?? input.invokeTime ?? input.date ?? new Date(),
    invoke_time: input.invoke_time ?? input.invokeTime ?? input.date,
    create_by: input.create_by ?? auditBy,
    create_date: input.create_date,
    update_by: input.update_by ?? auditBy,
    update_date: input.update_date,
    execution_id: input.execution_id,
    agent_id: input.agent_id,
    skill_source: input.skill_source,
    invoke_mode: input.invoke_mode,
    invoke_end_time: input.invoke_end_time,
    status: input.status,
    error_message: input.error_message,
  });
  logger.debug(`[UsageReport] queued skill-invoke: ${input.skillId}`);
}

export interface RecordExecutionInput {
  execution_id: string;
  conversation_id: string;
  turn_index?: number;
  entry_source: 'chat' | 'digital_employee' | 'schedule';
  agent_type: 'normal' | 'digital_employee';
  agent_id: string;
  model_id: string;
  status: 'success' | 'failed' | 'cancelled';
  started_at?: string;
  ended_at?: string;
  first_response_ms?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  create_date?: string;
  update_date?: string;
  error_stage?: 'client' | 'gateway' | 'model';
  error_message?: string;
}

export async function recordExecution(input: RecordExecutionInput): Promise<void> {
  const executionId = (input.execution_id || '').trim();
  const conversationId = (input.conversation_id || '').trim();
  if (!executionId || !conversationId) return;
  const workNo = await resolveWorkNo();
  await appendExecutionRecord({
    workNo,
    create_by: workNo,
    update_by: workNo,
    ...input,
    app_version: app.getVersion(),
  });
  logger.debug(`[UsageReport] queued execution: ${executionId} ${input.status}`);
}

export async function getReportingStatus(): Promise<{
  queue: Awaited<ReturnType<typeof getUsageReportQueueSnapshot>>;
  lastUploadAt: {
    tokenConsume: string | null;
    skillDownload: string | null;
    skillInvoke: string | null;
    execution: string | null;
  };
}> {
  const queue = await getUsageReportQueueSnapshot();
  const lastUploadAt = (await getSetting('usageReportLastUploadAt')) ?? {
    tokenConsume: null,
    skillDownload: null,
    skillInvoke: null,
    execution: null,
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
