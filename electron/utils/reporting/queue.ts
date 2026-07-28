/**
 * Persistent queue for usage-report records.
 *
 * Append/snapshot/clear operations are serialized through a per-process
 * promise chain so concurrent writers can't lose records when two callers
 * update electron-store at the same time.
 */

import { getSetting, setSetting } from '../store';
import {
  formatReportDateTime,
  isValidReportDate,
  isValidReportDateTime,
} from './time';
import type {
  ExecutionRecord,
  ReportingChannel,
  SkillDownloadRecord,
  SkillInvokeMode,
  SkillInvokeRecord,
  SkillInvokeStatus,
  TokenConsumeRecord,
  UsageReportQueueSnapshot,
} from './types';
import { normalizeSkillInvokeReportSource } from '../../../shared/reporting/skill-invoke-source';

let writeChain: Promise<void> = Promise.resolve();

function serializeWrite<T>(task: () => Promise<T>): Promise<T> {
  // Chain the new task on the previous one so reads/writes interleave safely
  // even when the renderer fires several appends within the same tick.
  const next = writeChain.then(() => task());
  writeChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function emptyQueue(): UsageReportQueueSnapshot {
  return {
    tokenConsume: [],
    skillDownload: [],
    skillInvoke: [],
    execution: [],
  };
}

async function readQueueRaw(): Promise<UsageReportQueueSnapshot> {
  const stored = await getSetting('usageReportQueue');
  if (!stored || typeof stored !== 'object') {
    return emptyQueue();
  }
  // Migrate any pre-rename token-consume records that still carry `date`
  // instead of `consumeTime` so a queued record from the previous build
  // doesn't fail backend validation after upgrade.
  const tokenConsume = Array.isArray(stored.tokenConsume)
    ? stored.tokenConsume.map((record) => {
      const r = record as TokenConsumeRecord & { date?: string };
      if (r.consumeTime) return r as TokenConsumeRecord;
      const fallback = typeof r.date === 'string'
        ? (isValidReportDateTime(r.date) ? r.date : (isValidReportDate(r.date) ? `${r.date}:00` : undefined))
        : undefined;
      return {
        workNo: r.workNo ?? '',
        model: r.model ?? '',
        consume: r.consume ?? 0,
        consumeTime: fallback ?? formatReportDateTime(new Date()),
      } satisfies TokenConsumeRecord;
    })
    : [];
  // Migrate pre-rename skill-download records that still carry `date` instead
  // of `downloadTime`, padding minute-precision strings to seconds.
  const skillDownload = Array.isArray(stored.skillDownload)
    ? stored.skillDownload.map((record) => {
      const r = record as SkillDownloadRecord & { date?: string };
      if (r.downloadTime) return r as SkillDownloadRecord;
      const fallback = typeof r.date === 'string'
        ? (isValidReportDateTime(r.date) ? r.date : (isValidReportDate(r.date) ? `${r.date}:00` : undefined))
        : undefined;
      return {
        workNo: r.workNo ?? '',
        skillId: r.skillId ?? '',
        count: r.count ?? 0,
        downloadTime: fallback ?? formatReportDateTime(new Date()),
      } satisfies SkillDownloadRecord;
    })
    : [];
  // Migrate pre-rename skill-invoke records (`date` → `invokeTime`).
  const skillInvoke = Array.isArray(stored.skillInvoke)
    ? stored.skillInvoke.map((record) => normalizeStoredSkillInvokeRecord(record))
    : [];
  const execution = Array.isArray(stored.execution)
    ? stored.execution.map((record) => {
      const r = record as ExecutionRecord;
      return {
        execution_id: r.execution_id ?? '',
        conversation_id: r.conversation_id ?? '',
        turn_index: typeof r.turn_index === 'number' ? r.turn_index : undefined,
        work_no: r.work_no ?? '',
        entry_source: r.entry_source ?? 'chat',
        agent_type: r.agent_type ?? 'normal',
        agent_id: r.agent_id ?? '',
        model_id: r.model_id ?? '',
        status: r.status ?? 'success',
        started_at: r.started_at,
        ended_at: r.ended_at,
        first_response_ms: typeof r.first_response_ms === 'number' ? r.first_response_ms : undefined,
        input_tokens: typeof r.input_tokens === 'number' ? r.input_tokens : undefined,
        output_tokens: typeof r.output_tokens === 'number' ? r.output_tokens : undefined,
        cache_read_tokens: typeof r.cache_read_tokens === 'number' ? r.cache_read_tokens : undefined,
        create_by: r.create_by,
        create_date: r.create_date,
        update_by: r.update_by,
        update_date: r.update_date,
        error_stage: r.error_stage,
        error_message: r.error_message,
        app_version: r.app_version,
      } satisfies ExecutionRecord;
    })
    : [];
  return {
    tokenConsume,
    skillDownload,
    skillInvoke,
    execution,
  };
}

async function writeQueueRaw(queue: UsageReportQueueSnapshot): Promise<void> {
  await setSetting('usageReportQueue', queue);
}

function ensureValidDateTime(input: unknown): string {
  if (isValidReportDateTime(input)) return input;
  // Promote legacy minute-precision "YYYY-MM-DD HH:MM" callers by padding :00
  // rather than discarding the original timestamp.
  if (isValidReportDate(input)) return `${input}:00`;
  if (input instanceof Date || typeof input === 'number' || typeof input === 'string') {
    return formatReportDateTime(input);
  }
  return formatReportDateTime(new Date());
}

function normalizeCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
  if (value <= 0) return 1;
  return Math.floor(value);
}

function normalizeConsume(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

export async function getUsageReportQueueSnapshot(): Promise<UsageReportQueueSnapshot> {
  return await readQueueRaw();
}

export interface AppendTokenConsumeInput {
  workNo: string;
  model: string;
  consume: number;
  /**
   * Either a Date / epoch / ISO string (will be formatted to local
   * "YYYY-MM-DD HH:MM:SS") or an already-formatted backend string.
   * The legacy alias `date` is accepted for backward compatibility with
   * earlier renderer payloads that haven't been redeployed yet.
   */
  consumeTime?: string | Date | number;
  date?: string | Date | number;
}

export async function appendTokenConsumeRecord(input: AppendTokenConsumeInput): Promise<void> {
  const consume = normalizeConsume(input.consume);
  // 0-token records carry no signal and would only inflate the upload payload.
  if (consume === 0) return;
  const model = (input.model || '').trim();
  if (!model) return;
  const rawTime = input.consumeTime ?? input.date ?? new Date();
  const record: TokenConsumeRecord = {
    workNo: (input.workNo || '').trim(),
    model,
    consume,
    consumeTime: ensureValidDateTime(rawTime),
  };
  await serializeWrite(async () => {
    const queue = await readQueueRaw();
    queue.tokenConsume.push(record);
    await writeQueueRaw(queue);
  });
}

export interface AppendSkillDownloadInput {
  workNo: string;
  skillId: string;
  count?: number;
  /**
   * "YYYY-MM-DD HH:MM:SS" — backend field is `downloadTime`. Date / epoch /
   * ISO inputs are formatted in local time. The legacy alias `date` is
   * accepted for backward compatibility with old renderer payloads.
   */
  downloadTime?: string | Date | number;
  date?: string | Date | number;
}

export async function appendSkillDownloadRecord(input: AppendSkillDownloadInput): Promise<void> {
  const skillId = (input.skillId || '').trim();
  if (!skillId) return;
  const rawTime = input.downloadTime ?? input.date ?? new Date();
  const record: SkillDownloadRecord = {
    workNo: (input.workNo || '').trim(),
    skillId,
    count: normalizeCount(input.count ?? 1),
    downloadTime: ensureValidDateTime(rawTime),
  };
  await serializeWrite(async () => {
    const queue = await readQueueRaw();
    queue.skillDownload.push(record);
    await writeQueueRaw(queue);
  });
}

function trimErrorMessage(value: unknown): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return undefined;
  return trimmed.slice(0, 1024);
}

function normalizeSkillInvokeStatus(value: unknown): SkillInvokeStatus | undefined {
  if (value === 'success' || value === 'failed' || value === 'cancelled' || value === 'unknown') {
    return value;
  }
  return undefined;
}

function normalizeSkillInvokeMode(value: unknown): SkillInvokeMode | undefined {
  if (value === 'user_selected' || value === 'model_selected') return value;
  return undefined;
}

/** Fill every skill-invoke field so JSON persistence stays complete. */
export function finalizeSkillInvokeRecord(record: unknown): SkillInvokeRecord {
  const r = record as SkillInvokeRecord & { date?: string };
  const legacyTime = typeof r.invokeTime === 'string' && r.invokeTime.trim()
    ? r.invokeTime
    : undefined;
  const fallback = typeof r.date === 'string'
    ? (isValidReportDateTime(r.date) ? r.date : (isValidReportDate(r.date) ? `${r.date}:00` : undefined))
    : undefined;
  const invokeTime = ensureValidDateTime(r.invoke_time ?? legacyTime ?? fallback ?? new Date());
  const workNo = (r.workNo ?? '').trim();
  const auditBy = (r.create_by || r.update_by || workNo).trim() || workNo;
  const invokeMode = normalizeSkillInvokeMode(r.invoke_mode) ?? 'user_selected';
  const status = normalizeSkillInvokeStatus(r.status) ?? 'unknown';
  const createDate = typeof r.create_date === 'string' && r.create_date.trim()
    ? ensureValidDateTime(r.create_date)
    : invokeTime;
  const updateDate = typeof r.update_date === 'string' && r.update_date.trim()
    ? ensureValidDateTime(r.update_date)
    : invokeTime;
  const invokeEndTime = typeof r.invoke_end_time === 'string' && r.invoke_end_time.trim()
    ? ensureValidDateTime(r.invoke_end_time)
    : '';
  return {
    workNo,
    skillId: (r.skillId ?? '').trim(),
    count: normalizeCount(r.count ?? 1),
    invokeTime,
    create_by: auditBy,
    update_by: auditBy,
    create_date: createDate,
    update_date: updateDate,
    execution_id: (r.execution_id ?? '').trim(),
    agent_id: (r.agent_id ?? '').trim() || 'main',
    skill_source: normalizeSkillInvokeReportSource(r.skill_source, {
      numericMarketplaceId: /^\d+$/.test((r.skillId ?? '').trim()),
    }),
    invoke_mode: invokeMode,
    invoke_time: invokeTime,
    invoke_end_time: invokeEndTime,
    status,
    error_message: trimErrorMessage(r.error_message) ?? '',
  };
}

function normalizeStoredSkillInvokeRecord(record: unknown): SkillInvokeRecord {
  return finalizeSkillInvokeRecord(record);
}

export interface AppendSkillInvokeInput {
  workNo: string;
  skillId: string;
  count?: number;
  invokeTime?: string | Date | number;
  date?: string | Date | number;
  create_by?: string;
  create_date?: string | Date | number;
  update_by?: string;
  update_date?: string | Date | number;
  execution_id?: string;
  agent_id?: string;
  skill_source?: string;
  invoke_mode?: SkillInvokeMode;
  invoke_time?: string | Date | number;
  invoke_end_time?: string | Date | number;
  status?: SkillInvokeStatus;
  error_message?: string;
}

export async function appendSkillInvokeRecord(input: AppendSkillInvokeInput): Promise<void> {
  const skillId = (input.skillId || '').trim();
  if (!skillId) return;
  const workNo = (input.workNo || '').trim();
  const rawInvokeTime = input.invoke_time ?? input.invokeTime ?? input.date ?? new Date();
  const invokeTime = ensureValidDateTime(rawInvokeTime);
  const auditBy = (input.create_by || input.update_by || workNo).trim() || workNo;
  const record = finalizeSkillInvokeRecord({
    workNo,
    skillId,
    count: normalizeCount(input.count ?? 1),
    invokeTime,
    create_by: auditBy,
    create_date: input.create_date,
    update_by: auditBy,
    update_date: input.update_date,
    execution_id: input.execution_id,
    agent_id: input.agent_id,
    skill_source: input.skill_source,
    invoke_mode: input.invoke_mode,
    invoke_time: invokeTime,
    invoke_end_time: input.invoke_end_time,
    status: input.status,
    error_message: input.error_message,
  });
  await serializeWrite(async () => {
    const queue = await readQueueRaw();
    queue.skillInvoke.push(record);
    await writeQueueRaw(queue);
  });
}

export interface AppendExecutionInput {
  workNo: string;
  execution_id: string;
  conversation_id: string;
  turn_index?: number;
  entry_source: ExecutionRecord['entry_source'];
  agent_type: ExecutionRecord['agent_type'];
  agent_id: string;
  model_id: string;
  status: ExecutionRecord['status'];
  started_at?: string;
  ended_at?: string;
  first_response_ms?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  create_by?: string;
  create_date?: string;
  update_by?: string;
  update_date?: string;
  error_stage?: ExecutionRecord['error_stage'];
  error_message?: string;
  app_version?: string;
}

export async function appendExecutionRecord(input: AppendExecutionInput): Promise<void> {
  const executionId = (input.execution_id || '').trim();
  const conversationId = (input.conversation_id || '').trim();
  const agentId = (input.agent_id || '').trim();
  const modelId = (input.model_id || '').trim();
  if (!executionId || !conversationId || !agentId || !modelId) return;
  const workNo = (input.workNo || '').trim();
  const auditBy = (input.create_by || input.update_by || workNo).trim() || workNo;
  const record: ExecutionRecord = {
    execution_id: executionId,
    conversation_id: conversationId,
    turn_index: typeof input.turn_index === 'number' && input.turn_index > 0
      ? Math.floor(input.turn_index)
      : undefined,
    work_no: workNo,
    entry_source: input.entry_source,
    agent_type: input.agent_type,
    agent_id: agentId,
    model_id: modelId,
    status: input.status,
    started_at: input.started_at ? ensureValidDateTime(input.started_at) : undefined,
    ended_at: input.ended_at ? ensureValidDateTime(input.ended_at) : undefined,
    first_response_ms: typeof input.first_response_ms === 'number' && input.first_response_ms >= 0
      ? Math.floor(input.first_response_ms)
      : undefined,
    input_tokens: typeof input.input_tokens === 'number' && input.input_tokens >= 0
      ? Math.floor(input.input_tokens)
      : undefined,
    output_tokens: typeof input.output_tokens === 'number' && input.output_tokens >= 0
      ? Math.floor(input.output_tokens)
      : undefined,
    cache_read_tokens: typeof input.cache_read_tokens === 'number' && input.cache_read_tokens >= 0
      ? Math.floor(input.cache_read_tokens)
      : undefined,
    create_by: (input.create_by || auditBy).trim() || undefined,
    create_date: input.create_date ? ensureValidDateTime(input.create_date) : undefined,
    update_by: (input.update_by || auditBy).trim() || undefined,
    update_date: input.update_date ? ensureValidDateTime(input.update_date) : undefined,
    error_stage: input.error_stage,
    error_message: typeof input.error_message === 'string' && input.error_message.trim()
      ? input.error_message.trim().slice(0, 1024)
      : undefined,
    app_version: (input.app_version || '').trim() || undefined,
  };
  await serializeWrite(async () => {
    const queue = await readQueueRaw();
    queue.execution.push(record);
    await writeQueueRaw(queue);
  });
}

/**
 * Atomically detach all records from the queue and return them.
 * Records returned here are NOT considered "uploaded" — the caller
 * (uploader) must restore them via `restoreFailedRecords` if shipping fails.
 */
export async function detachAllRecords(): Promise<UsageReportQueueSnapshot> {
  return await serializeWrite(async () => {
    const queue = await readQueueRaw();
    await writeQueueRaw(emptyQueue());
    return queue;
  });
}

/**
 * Re-prepend records that failed to upload, so they retry on the next flush.
 * Prepend (not append) keeps original chronological ordering when newer
 * records were appended between detach and restore.
 */
export async function restoreFailedRecords(failed: Partial<UsageReportQueueSnapshot>): Promise<void> {
  const tokenConsume = failed.tokenConsume ?? [];
  const skillDownload = failed.skillDownload ?? [];
  const skillInvoke = failed.skillInvoke ?? [];
  const execution = failed.execution ?? [];
  if (
    tokenConsume.length === 0
    && skillDownload.length === 0
    && skillInvoke.length === 0
    && execution.length === 0
  ) {
    return;
  }
  await serializeWrite(async () => {
    const queue = await readQueueRaw();
    queue.tokenConsume = [...tokenConsume, ...queue.tokenConsume];
    queue.skillDownload = [...skillDownload, ...queue.skillDownload];
    queue.skillInvoke = [...skillInvoke, ...queue.skillInvoke];
    queue.execution = [...execution, ...queue.execution];
    await writeQueueRaw(queue);
  });
}

export async function recordSuccessfulUpload(channel: ReportingChannel, isoTimestamp: string): Promise<void> {
  const last = (await getSetting('usageReportLastUploadAt')) ?? {
    tokenConsume: null,
    skillDownload: null,
    skillInvoke: null,
    execution: null,
  };
  await setSetting('usageReportLastUploadAt', {
    ...last,
    [channel]: isoTimestamp,
  });
}
