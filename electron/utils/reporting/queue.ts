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
  ReportingChannel,
  SkillDownloadRecord,
  SkillInvokeRecord,
  TokenConsumeRecord,
  UsageReportQueueSnapshot,
} from './types';

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
    ? stored.skillInvoke.map((record) => {
      const r = record as SkillInvokeRecord & { date?: string };
      if (r.invokeTime) return r as SkillInvokeRecord;
      const fallback = typeof r.date === 'string'
        ? (isValidReportDateTime(r.date) ? r.date : (isValidReportDate(r.date) ? `${r.date}:00` : undefined))
        : undefined;
      return {
        workNo: r.workNo ?? '',
        skillId: r.skillId ?? '',
        count: r.count ?? 0,
        invokeTime: fallback ?? formatReportDateTime(new Date()),
      } satisfies SkillInvokeRecord;
    })
    : [];
  return {
    tokenConsume,
    skillDownload,
    skillInvoke,
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

export interface AppendSkillInvokeInput {
  workNo: string;
  skillId: string;
  count?: number;
  /**
   * "YYYY-MM-DD HH:MM:SS" — backend field is `invokeTime`. Date / epoch /
   * ISO inputs are formatted in local time. The legacy alias `date` is
   * accepted for backward compatibility with old renderer payloads.
   */
  invokeTime?: string | Date | number;
  date?: string | Date | number;
}

export async function appendSkillInvokeRecord(input: AppendSkillInvokeInput): Promise<void> {
  const skillId = (input.skillId || '').trim();
  if (!skillId) return;
  const rawTime = input.invokeTime ?? input.date ?? new Date();
  const record: SkillInvokeRecord = {
    workNo: (input.workNo || '').trim(),
    skillId,
    count: normalizeCount(input.count ?? 1),
    invokeTime: ensureValidDateTime(rawTime),
  };
  await serializeWrite(async () => {
    const queue = await readQueueRaw();
    queue.skillInvoke.push(record);
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
  if (tokenConsume.length === 0 && skillDownload.length === 0 && skillInvoke.length === 0) {
    return;
  }
  await serializeWrite(async () => {
    const queue = await readQueueRaw();
    queue.tokenConsume = [...tokenConsume, ...queue.tokenConsume];
    queue.skillDownload = [...skillDownload, ...queue.skillDownload];
    queue.skillInvoke = [...skillInvoke, ...queue.skillInvoke];
    await writeQueueRaw(queue);
  });
}

export async function recordSuccessfulUpload(channel: ReportingChannel, isoTimestamp: string): Promise<void> {
  const last = (await getSetting('usageReportLastUploadAt')) ?? {
    tokenConsume: null,
    skillDownload: null,
    skillInvoke: null,
  };
  await setSetting('usageReportLastUploadAt', {
    ...last,
    [channel]: isoTimestamp,
  });
}
