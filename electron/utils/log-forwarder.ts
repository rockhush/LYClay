import { mkdir, readFile, readdir, rm, stat, writeFile, appendFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { isElkEligibleSnapshot, type ErrorSnapshotDocument, type SnapshotPriority, type SnapshotWriteQueue } from './error-snapshot';

export type LogServerReachability = 'unknown' | 'reachable' | 'unreachable' | 'rejected';

export type LogForwardResult =
  | { ok: true; ackId?: string }
  | { ok: false; reason: 'disabled' | 'network' | 'rejected' };

export interface LogForwardClient {
  send(batch: ErrorSnapshotDocument[]): Promise<LogForwardResult>;
}

type ScheduleTimer = (callback: () => void, delayMs: number) => () => void;

function scheduleUnrefTimeout(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}

interface SpoolEntry {
  fileName: string;
  fileDate: string;
  snapshot: unknown;
  snapshotId: string | null;
  endOffset: number;
  lineNumber: number;
}

interface SnapshotAckFile {
  file: string;
  ackedOffset: number;
  ackedLine: number;
  lastSnapshotId: string | null;
  lastAckId: string | null;
  updatedAt: string;
  legacySentSnapshotIds?: string[];
}

const SNAPSHOT_FILE_PATTERN = /^LYClaw-(\d{4}-\d{2}-\d{2})\.snapshot\.jsonl$/;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000];

export const DEFAULT_ELK_TCP_HOST = '10.0.1.62';
export const DEFAULT_ELK_TCP_PORT = 5213;
export const DEFAULT_ELK_TCP_TIMEOUT_MS = 5_000;

function dateFromIso(iso: string): string {
  return iso.slice(0, 10);
}

function snapshotFileName(iso: string): string {
  return `LYClaw-${dateFromIso(iso)}.snapshot.jsonl`;
}

function ackFileName(date: string): string {
  return `LYClaw-${date}.snapshot.ack.json`;
}

function toTime(iso: string): number {
  const time = Date.parse(iso);
  return Number.isFinite(time) ? time : Date.now();
}

async function readAck(spoolDir: string, fileName: string, date: string): Promise<SnapshotAckFile> {
  try {
    const raw = await readFile(join(spoolDir, ackFileName(date)), 'utf8');
    const parsed = JSON.parse(raw) as Partial<SnapshotAckFile> & { sentSnapshotIds?: unknown };
    return {
      file: typeof parsed.file === 'string' ? parsed.file : fileName,
      ackedOffset: typeof parsed.ackedOffset === 'number' && parsed.ackedOffset >= 0 ? parsed.ackedOffset : 0,
      ackedLine: typeof parsed.ackedLine === 'number' && parsed.ackedLine >= 0 ? parsed.ackedLine : 0,
      lastSnapshotId: typeof parsed.lastSnapshotId === 'string' ? parsed.lastSnapshotId : null,
      lastAckId: typeof parsed.lastAckId === 'string' ? parsed.lastAckId : null,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
      legacySentSnapshotIds: Array.isArray(parsed.sentSnapshotIds)
        ? parsed.sentSnapshotIds.filter((id): id is string => typeof id === 'string')
        : undefined,
    };
  } catch {
    return {
      file: fileName,
      ackedOffset: 0,
      ackedLine: 0,
      lastSnapshotId: null,
      lastAckId: null,
      updatedAt: new Date().toISOString(),
    };
  }
}

async function writeAck(spoolDir: string, date: string, ack: SnapshotAckFile): Promise<void> {
  await writeFile(join(spoolDir, ackFileName(date)), `${JSON.stringify(ack, null, 2)}\n`, 'utf8');
}

function sortSnapshots(a: ErrorSnapshotDocument, b: ErrorSnapshotDocument): number {
  if (a.priority !== b.priority) return a.priority === 'p0' ? -1 : 1;
  return toTime(a.ts) - toTime(b.ts);
}

function snapshotIdOf(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const snapshotId = (value as Record<string, unknown>).snapshotId;
  return typeof snapshotId === 'string' && snapshotId.length > 0 ? snapshotId : null;
}

function parseSpoolEntries(options: {
  body: Buffer;
  fileName: string;
  fileDate: string;
  ackedOffset: number;
  ackedLine: number;
}): SpoolEntry[] {
  const entries: SpoolEntry[] = [];
  let cursor = Math.min(Math.max(0, options.ackedOffset), options.body.length);
  let lineNumber = options.ackedLine;
  while (cursor < options.body.length) {
    const newline = options.body.indexOf(0x0a, cursor);
    const endOffset = newline >= 0 ? newline + 1 : options.body.length;
    const lineEnd = newline >= 0 ? newline : options.body.length;
    const trimmed = options.body.subarray(cursor, lineEnd).toString('utf8').trim();
    lineNumber += 1;
    cursor = endOffset;
    if (!trimmed) continue;
    let snapshot: unknown = null;
    try {
      snapshot = JSON.parse(trimmed);
    } catch {
      // Malformed historical lines are locally acknowledged and never forwarded.
    }
    entries.push({
      fileName: options.fileName,
      fileDate: options.fileDate,
      snapshot,
      snapshotId: snapshotIdOf(snapshot),
      endOffset,
      lineNumber,
    });
  }
  return entries;
}

async function listSpoolFiles(spoolDir: string): Promise<Array<{ fileName: string; date: string }>> {
  let names: string[];
  try {
    names = await readdir(spoolDir);
  } catch {
    return [];
  }
  return names
    .map((fileName) => ({ fileName, match: SNAPSHOT_FILE_PATTERN.exec(fileName) }))
    .filter((item): item is { fileName: string; match: RegExpExecArray } => item.match != null)
    .map((item) => ({ fileName: item.fileName, date: item.match[1] }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function readSpoolEntries(spoolDir: string): Promise<SpoolEntry[]> {
  const files = await listSpoolFiles(spoolDir);
  const entries: SpoolEntry[] = [];

  for (const file of files) {
    const ack = await readAck(spoolDir, file.fileName, file.date);
    const body = await readFile(join(spoolDir, file.fileName));
    let ackedOffset = ack.file === file.fileName ? ack.ackedOffset : 0;
    let ackedLine = ack.file === file.fileName ? ack.ackedLine : 0;
    if (ackedOffset === 0 && ack.legacySentSnapshotIds?.length) {
      const sent = new Set(ack.legacySentSnapshotIds);
      const legacyEntries = parseSpoolEntries({
        body,
        fileName: file.fileName,
        fileDate: file.date,
        ackedOffset: 0,
        ackedLine: 0,
      });
      const acknowledgedPrefix: SpoolEntry[] = [];
      for (const entry of legacyEntries) {
        if (!entry.snapshotId || !sent.has(entry.snapshotId)) break;
        acknowledgedPrefix.push(entry);
      }
      const last = acknowledgedPrefix[acknowledgedPrefix.length - 1];
      if (last) {
        ackedOffset = last.endOffset;
        ackedLine = last.lineNumber;
        await writeAck(spoolDir, file.date, {
          file: file.fileName,
          ackedOffset,
          ackedLine,
          lastSnapshotId: last.snapshotId,
          lastAckId: ack.lastAckId,
          updatedAt: ack.updatedAt,
        });
      }
    }
    entries.push(...parseSpoolEntries({
      body,
      fileName: file.fileName,
      fileDate: file.date,
      ackedOffset,
      ackedLine,
    }));
  }

  return entries;
}

export class SnapshotSpoolWriter {
  private readonly spoolDir: string;
  private readonly queue: SnapshotWriteQueue;
  private readonly now: () => string;
  private readonly append: (path: string, data: string, encoding: 'utf8') => Promise<void>;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: {
    spoolDir: string;
    queue: SnapshotWriteQueue;
    now: () => string;
    append?: (path: string, data: string, encoding: 'utf8') => Promise<void>;
  }) {
    this.spoolDir = options.spoolDir;
    this.queue = options.queue;
    this.now = options.now;
    this.append = options.append ?? appendFile;
  }

  async flush(priority?: SnapshotPriority): Promise<void> {
    const operation = this.writeChain.then(() => this.performFlush(priority));
    this.writeChain = operation.catch(() => {});
    await operation;
  }

  private async performFlush(priority?: SnapshotPriority): Promise<void> {
    const snapshots = this.queue.drain(priority).sort(sortSnapshots);
    if (snapshots.length === 0) return;

    try {
      await mkdir(this.spoolDir, { recursive: true });
      const filePath = join(this.spoolDir, snapshotFileName(this.now()));
      const body = snapshots.map((snapshot) => JSON.stringify(snapshot)).join('\n');
      await this.append(filePath, `${body}\n`, 'utf8');
    } catch (error) {
      this.queue.restore(snapshots);
      throw error;
    }
  }
}

export function createDisabledLogForwardClient(): LogForwardClient {
  return {
    async send() {
      return { ok: false, reason: 'disabled' };
    },
  };
}

export function createTcpLogForwardClient(options: {
  host?: string;
  port?: number;
  timeoutMs?: number;
  scheduleDeadline?: ScheduleTimer;
} = {}): LogForwardClient {
  const host = options.host ?? DEFAULT_ELK_TCP_HOST;
  const port = options.port ?? DEFAULT_ELK_TCP_PORT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_ELK_TCP_TIMEOUT_MS;
  const scheduleDeadline = options.scheduleDeadline ?? scheduleUnrefTimeout;

  return {
    async send(batch) {
      if (batch.length === 0) return { ok: true };
      const payload = `${batch.map((snapshot) => JSON.stringify(snapshot)).join('\n')}\n`;

      return await new Promise<LogForwardResult>((resolve) => {
        const socket = createConnection({ host, port });
        let settled = false;
        let writeCompleted = false;
        let cancelDeadline: (() => void) | null = null;

        const finish = (result: LogForwardResult): void => {
          if (settled) return;
          settled = true;
          cancelDeadline?.();
          cancelDeadline = null;
          resolve(result);
        };

        cancelDeadline = scheduleDeadline(() => {
          socket.destroy();
          finish({ ok: false, reason: 'network' });
        }, timeoutMs);
        socket.once('connect', () => {
          socket.end(payload, 'utf8', () => {
            writeCompleted = true;
          });
        });
        socket.once('error', () => {
          socket.destroy();
          finish({ ok: false, reason: 'network' });
        });
        socket.once('close', (hadError) => {
          finish(writeCompleted && !hadError
            ? { ok: true }
            : { ok: false, reason: 'network' });
        });
      });
    },
  };
}

export class LogForwarder {
  private readonly spoolDir: string;
  private readonly client: LogForwardClient;
  private readonly now: () => string;
  private readonly scheduleRetry: ScheduleTimer;
  private reachability: LogServerReachability = 'unknown';
  private failureCount = 0;
  private nextRetryAt = 0;
  private flushChain: Promise<void> = Promise.resolve();
  private cancelScheduledRetry: (() => void) | null = null;

  constructor(options: {
    spoolDir: string;
    client: LogForwardClient;
    now: () => string;
    scheduleRetry?: ScheduleTimer;
  }) {
    this.spoolDir = options.spoolDir;
    this.client = options.client;
    this.now = options.now;
    this.scheduleRetry = options.scheduleRetry ?? scheduleUnrefTimeout;
  }

  getReachability(): LogServerReachability {
    return this.reachability;
  }

  async flushOnce(): Promise<void> {
    const operation = this.flushChain.then(() => this.performFlushOnce());
    this.flushChain = operation.catch(() => {});
    await operation;
  }

  private async performFlushOnce(): Promise<void> {
    const nowIso = this.now();
    const nowTime = toTime(nowIso);
    if (nowTime < this.nextRetryAt || this.reachability === 'rejected') return;

    const entries = await readSpoolEntries(this.spoolDir);
    if (entries.length === 0) return;

    const eligibleEntries = entries
      .filter((entry): entry is SpoolEntry & { snapshot: ErrorSnapshotDocument } => isElkEligibleSnapshot(entry.snapshot))
      .sort((a, b) => sortSnapshots(a.snapshot, b.snapshot));
    if (eligibleEntries.length === 0) {
      await this.recordAck(entries, null, nowIso);
      return;
    }

    const result = await this.client.send(eligibleEntries.map((entry) => entry.snapshot));
    if (result.ok === true) {
      this.reachability = 'reachable';
      this.failureCount = 0;
      this.nextRetryAt = 0;
      this.cancelScheduledRetry?.();
      this.cancelScheduledRetry = null;
      await this.recordAck(entries, result.ackId ?? null, nowIso);
      return;
    }

    await this.ackLeadingSkippedEntries(entries, nowIso);

    const failure = result as Extract<LogForwardResult, { ok: false }>;
    if (failure.reason === 'disabled') {
      return;
    }

    this.reachability = failure.reason === 'rejected' ? 'rejected' : 'unreachable';
    const delay = RETRY_DELAYS_MS[Math.min(this.failureCount, RETRY_DELAYS_MS.length - 1)];
    this.failureCount += 1;
    this.nextRetryAt = nowTime + delay;
    this.scheduleRetryFlush(delay);
  }

  private scheduleRetryFlush(delayMs: number): void {
    if (this.cancelScheduledRetry) return;
    this.cancelScheduledRetry = this.scheduleRetry(() => {
      this.cancelScheduledRetry = null;
      void this.flushOnce().catch(() => {
        this.scheduleRetryFlush(delayMs);
      });
    }, delayMs);
  }

  private async recordAck(entries: SpoolEntry[], ackId: string | null, nowIso: string): Promise<void> {
    const byDate = new Map<string, SpoolEntry[]>();
    for (const entry of entries) {
      const grouped = byDate.get(entry.fileDate) ?? [];
      grouped.push(entry);
      byDate.set(entry.fileDate, grouped);
    }

    for (const [date, grouped] of byDate) {
      const ordered = grouped.sort((a, b) => a.endOffset - b.endOffset);
      const last = ordered[ordered.length - 1];
      const ack = await readAck(this.spoolDir, last.fileName, date);
      const lastSnapshotId = [...ordered].reverse().find((entry) => entry.snapshotId)?.snapshotId
        ?? ack.lastSnapshotId;
      await writeAck(this.spoolDir, date, {
        file: last.fileName,
        ackedOffset: Math.max(ack.ackedOffset, last.endOffset),
        ackedLine: Math.max(ack.ackedLine, last.lineNumber),
        lastSnapshotId,
        lastAckId: ackId,
        updatedAt: nowIso,
      });
    }
  }

  private async ackLeadingSkippedEntries(entries: SpoolEntry[], nowIso: string): Promise<void> {
    const byFile = new Map<string, SpoolEntry[]>();
    for (const entry of entries) {
      const grouped = byFile.get(entry.fileName) ?? [];
      grouped.push(entry);
      byFile.set(entry.fileName, grouped);
    }
    const leadingSkipped: SpoolEntry[] = [];
    for (const grouped of byFile.values()) {
      for (const entry of grouped.sort((a, b) => a.endOffset - b.endOffset)) {
        if (isElkEligibleSnapshot(entry.snapshot)) break;
        leadingSkipped.push(entry);
      }
    }
    if (leadingSkipped.length > 0) {
      await this.recordAck(leadingSkipped, null, nowIso);
    }
  }
}

async function fileHasPriority(spoolDir: string, fileName: string, priority: SnapshotPriority): Promise<boolean> {
  try {
    const raw = await readFile(join(spoolDir, fileName), 'utf8');
    return raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .some((line) => {
        try {
          return (JSON.parse(line) as Partial<ErrorSnapshotDocument>).priority === priority;
        } catch {
          return false;
        }
      });
  } catch {
    return false;
  }
}

export async function applySnapshotRetention(options: {
  spoolDir: string;
  now: () => string;
  retentionDays: number;
  maxBytes: number;
}): Promise<void> {
  const files = await listSpoolFiles(options.spoolDir);
  const nowTime = toTime(options.now());
  const minTime = nowTime - Math.max(0, options.retentionDays) * 24 * 60 * 60 * 1000;

  for (const file of files) {
    const fileTime = Date.parse(`${file.date}T00:00:00.000Z`);
    if (fileTime >= minTime) continue;
    if (await fileHasPriority(options.spoolDir, file.fileName, 'p0')) continue;
    await rm(join(options.spoolDir, file.fileName), { force: true });
  }

  const remaining = await listSpoolFiles(options.spoolDir);
  let totalBytes = 0;
  const stats = await Promise.all(remaining.map(async (file) => {
    const filePath = join(options.spoolDir, file.fileName);
    const info = await stat(filePath);
    totalBytes += info.size;
    return {
      ...file,
      filePath,
      size: info.size,
      hasP0: await fileHasPriority(options.spoolDir, file.fileName, 'p0'),
    };
  }));

  for (const file of stats.sort((a, b) => a.date.localeCompare(b.date))) {
    if (totalBytes <= options.maxBytes) break;
    if (file.hasP0) continue;
    await rm(file.filePath, { force: true });
    totalBytes -= file.size;
  }
}
