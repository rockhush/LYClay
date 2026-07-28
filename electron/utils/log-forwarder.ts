import { mkdir, readFile, readdir, rm, stat, writeFile, appendFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import type { ErrorSnapshotDocument, SnapshotPriority, SnapshotWriteQueue } from './error-snapshot';

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
  snapshot: ErrorSnapshotDocument;
}

interface SnapshotAckFile {
  sentSnapshotIds: string[];
  lastAckId: string | null;
  updatedAt: string;
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

async function readAck(spoolDir: string, date: string): Promise<SnapshotAckFile> {
  try {
    const raw = await readFile(join(spoolDir, ackFileName(date)), 'utf8');
    const parsed = JSON.parse(raw) as Partial<SnapshotAckFile>;
    return {
      sentSnapshotIds: Array.isArray(parsed.sentSnapshotIds) ? parsed.sentSnapshotIds.filter((id): id is string => typeof id === 'string') : [],
      lastAckId: typeof parsed.lastAckId === 'string' ? parsed.lastAckId : null,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
    };
  } catch {
    return { sentSnapshotIds: [], lastAckId: null, updatedAt: new Date().toISOString() };
  }
}

async function writeAck(spoolDir: string, date: string, ack: SnapshotAckFile): Promise<void> {
  await writeFile(join(spoolDir, ackFileName(date)), `${JSON.stringify(ack, null, 2)}\n`, 'utf8');
}

function sortSnapshots(a: ErrorSnapshotDocument, b: ErrorSnapshotDocument): number {
  if (a.priority !== b.priority) return a.priority === 'p0' ? -1 : 1;
  return toTime(a.ts) - toTime(b.ts);
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
    const ack = await readAck(spoolDir, file.date);
    const sent = new Set(ack.sentSnapshotIds);
    const raw = await readFile(join(spoolDir, file.fileName), 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const snapshot = JSON.parse(trimmed) as ErrorSnapshotDocument;
        if (!snapshot.snapshotId || sent.has(snapshot.snapshotId)) continue;
        entries.push({ fileName: file.fileName, fileDate: file.date, snapshot });
      } catch {
        continue;
      }
    }
  }

  return entries.sort((a, b) => sortSnapshots(a.snapshot, b.snapshot));
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

    await mkdir(this.spoolDir, { recursive: true });
    const filePath = join(this.spoolDir, snapshotFileName(this.now()));
    const body = snapshots.map((snapshot) => JSON.stringify(snapshot)).join('\n');
    await this.append(filePath, `${body}\n`, 'utf8');
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

    const result = await this.client.send(entries.map((entry) => entry.snapshot));
    if (result.ok === true) {
      this.reachability = 'reachable';
      this.failureCount = 0;
      this.nextRetryAt = 0;
      this.cancelScheduledRetry?.();
      this.cancelScheduledRetry = null;
      await this.recordAck(entries, result.ackId ?? null, nowIso);
      return;
    }

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
    const byDate = new Map<string, string[]>();
    for (const entry of entries) {
      const ids = byDate.get(entry.fileDate) ?? [];
      ids.push(entry.snapshot.snapshotId);
      byDate.set(entry.fileDate, ids);
    }

    for (const [date, ids] of byDate) {
      const ack = await readAck(this.spoolDir, date);
      const sent = new Set([...ack.sentSnapshotIds, ...ids]);
      await writeAck(this.spoolDir, date, {
        sentSnapshotIds: Array.from(sent),
        lastAckId: ackId,
        updatedAt: nowIso,
      });
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
