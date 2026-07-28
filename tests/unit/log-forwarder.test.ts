import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as logForwarderModule from '@electron/utils/log-forwarder';
import {
  SnapshotSpoolWriter,
  LogForwarder,
  applySnapshotRetention,
  createDisabledLogForwardClient,
  createTcpLogForwardClient,
} from '@electron/utils/log-forwarder';
import { createSnapshotWriteQueue, type ErrorSnapshotDocument } from '@electron/utils/error-snapshot';

let tempDir: string;

function snapshot(id: string, priority: 'p0' | 'p1', ts = '2026-07-22T08:00:00.000Z'): ErrorSnapshotDocument {
  return {
    documentType: 'error_snapshot',
    schemaVersion: 1,
    snapshotId: id,
    ts,
    priority,
    level: priority === 'p0' ? 'error' : 'warn',
    source: 'hostapi',
    eventName: 'hostapi.request_error',
    component: 'hostapi',
    errorCode: 'HOSTAPI_ROUTE_FAILED',
    message: `complete snapshot ${id}`,
    workNo: 'EMP00123',
    userName: '林一',
    identityMissingReason: null,
    recentEvents: [],
    metadata: { safe: true },
    truncated: false,
  };
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'lyclaw-log-forwarder-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('log forwarder spool', () => {
  it('serializes spool appends across overlapping writer flushes', async () => {
    const queue = createSnapshotWriteQueue({ maxItems: 1000, maxBytes: 8 * 1024 * 1024 });
    queue.enqueue(snapshot('writer-first', 'p0'));
    let releaseFirstAppend: (() => void) | undefined;
    const firstAppendPending = new Promise<void>((resolve) => {
      releaseFirstAppend = resolve;
    });
    let activeAppends = 0;
    let maxActiveAppends = 0;
    const append = vi.fn(async () => {
      activeAppends += 1;
      maxActiveAppends = Math.max(maxActiveAppends, activeAppends);
      if (append.mock.calls.length === 1) await firstAppendPending;
      activeAppends -= 1;
    });
    const options = {
      spoolDir: tempDir,
      queue,
      now: () => '2026-07-22T08:00:00.000Z',
      append,
    };
    const writer = new SnapshotSpoolWriter(options);

    const firstFlush = writer.flush();
    await vi.waitFor(() => expect(append).toHaveBeenCalledTimes(1));
    queue.enqueue(snapshot('writer-second', 'p0'));
    const secondFlush = writer.flush();
    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseFirstAppend?.();
    await Promise.all([firstFlush, secondFlush]);

    expect(append).toHaveBeenCalledTimes(2);
    expect(maxActiveAppends).toBe(1);
  });

  it('sends a snapshot batch as newline-delimited JSON over one TCP connection', async () => {
    expect(Reflect.get(logForwarderModule, 'createTcpLogForwardClient')).toBeTypeOf('function');

    let received = '';
    const server = createServer((socket) => {
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        received += chunk;
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('TCP test server did not expose a port');

    try {
      const client = createTcpLogForwardClient({
        host: '127.0.0.1',
        port: address.port,
        timeoutMs: 1_000,
      });
      await expect(client.send([
        snapshot('tcp-first', 'p0'),
        snapshot('tcp-second', 'p1'),
      ])).resolves.toEqual({ ok: true });

      expect(received.endsWith('\n')).toBe(true);
      expect(received.trim().split('\n').map((line) => JSON.parse(line).snapshotId))
        .toEqual(['tcp-first', 'tcp-second']);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('keeps TCP snapshots unacked when the connection fails', async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const address = probe.address();
    if (!address || typeof address === 'string') throw new Error('TCP probe did not expose a port');
    await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));

    const spoolFile = join(tempDir, 'LYClaw-2026-07-22.snapshot.jsonl');
    await writeFile(spoolFile, `${JSON.stringify(snapshot('tcp-unacked', 'p0'))}\n`);
    const forwarder = new LogForwarder({
      spoolDir: tempDir,
      client: createTcpLogForwardClient({ host: '127.0.0.1', port: address.port, timeoutMs: 200 }),
      now: () => '2026-07-22T08:00:00.000Z',
    });

    await forwarder.flushOnce();

    expect(forwarder.getReachability()).toBe('unreachable');
    await expect(readFile(join(tempDir, 'LYClaw-2026-07-22.snapshot.ack.json'), 'utf8')).rejects.toThrow();
    await expect(readFile(spoolFile, 'utf8')).resolves.toContain('tcp-unacked');
  });

  it('enforces one end-to-end TCP deadline even when the peer stays active', async () => {
    const sockets = new Set<Socket>();
    const intervals = new Set<NodeJS.Timeout>();
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      sockets.add(socket);
      socket.on('end', () => {
        const interval = setInterval(() => {
          if (!socket.destroyed) socket.write('still-open');
        }, 5);
        intervals.add(interval);
      });
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('TCP deadline server did not expose a port');

    let result: unknown;
    try {
      const client = createTcpLogForwardClient({ host: '127.0.0.1', port: address.port, timeoutMs: 30 });
      result = await Promise.race([
        client.send([snapshot('tcp-deadline', 'p0')]),
        new Promise((resolve) => setTimeout(() => resolve('deadline-not-enforced'), 150)),
      ]);
    } finally {
      for (const interval of intervals) clearInterval(interval);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }

    expect(result).toEqual({ ok: false, reason: 'network' });
  });

  it('registers an absolute TCP deadline for the whole send operation', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('TCP deadline probe did not expose a port');
    let expireDeadline: (() => void) | undefined;
    const scheduleDeadline = vi.fn((callback: () => void) => {
      expireDeadline = callback;
      return () => {};
    });

    try {
      const options = {
        host: '127.0.0.1',
        port: address.port,
        timeoutMs: 30,
        scheduleDeadline,
      };
      const sendPromise = createTcpLogForwardClient(options).send([snapshot('absolute-deadline', 'p0')]);
      expect(scheduleDeadline).toHaveBeenCalledWith(expect.any(Function), 30);
      expireDeadline?.();
      await expect(sendPromise).resolves.toEqual({ ok: false, reason: 'network' });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('coalesces concurrent flushes so the same unacked batch is sent once', async () => {
    await writeFile(
      join(tempDir, 'LYClaw-2026-07-22.snapshot.jsonl'),
      `${JSON.stringify(snapshot('concurrent-once', 'p0'))}\n`,
    );
    const send = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { ok: true as const };
    });
    const forwarder = new LogForwarder({
      spoolDir: tempDir,
      client: { send },
      now: () => '2026-07-22T08:00:00.000Z',
    });

    await Promise.all([forwarder.flushOnce(), forwarder.flushOnce()]);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('runs one follow-up flush when new spool data arrives during an active send', async () => {
    const spoolFile = join(tempDir, 'LYClaw-2026-07-22.snapshot.jsonl');
    await writeFile(spoolFile, `${JSON.stringify(snapshot('first-batch', 'p0'))}\n`);
    let releaseFirstSend: (() => void) | undefined;
    const firstSendPending = new Promise<void>((resolve) => {
      releaseFirstSend = resolve;
    });
    const send = vi.fn()
      .mockImplementationOnce(async () => {
        await firstSendPending;
        return { ok: true as const };
      })
      .mockResolvedValue({ ok: true as const });
    const forwarder = new LogForwarder({
      spoolDir: tempDir,
      client: { send },
      now: () => '2026-07-22T08:00:00.000Z',
    });

    const firstFlush = forwarder.flushOnce();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await appendFile(spoolFile, `${JSON.stringify(snapshot('second-batch', 'p0'))}\n`);
    const followUpFlush = forwarder.flushOnce();
    releaseFirstSend?.();
    await Promise.all([firstFlush, followUpFlush]);

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].map((item) => item.snapshotId)).toEqual(['second-batch']);
  });

  it('writes complete snapshot JSONL and records ack only after client success', async () => {
    const queue = createSnapshotWriteQueue({ maxItems: 1000, maxBytes: 8 * 1024 * 1024 });
    queue.enqueue(snapshot('p1-later', 'p1'));
    queue.enqueue(snapshot('p0-first', 'p0'));

    const writer = new SnapshotSpoolWriter({
      spoolDir: tempDir,
      queue,
      now: () => '2026-07-22T08:00:01.000Z',
    });
    await writer.flush();

    const spoolFile = join(tempDir, 'LYClaw-2026-07-22.snapshot.jsonl');
    const lines = (await readFile(spoolFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(lines.map((line) => line.snapshotId)).toEqual(['p0-first', 'p1-later']);
    expect(lines[0]).toEqual(expect.objectContaining({
      documentType: 'error_snapshot',
      message: 'complete snapshot p0-first',
      workNo: 'EMP00123',
      userName: '林一',
    }));

    const send = vi.fn(async (batch: ErrorSnapshotDocument[]) => ({
      ok: true,
      ackId: `ack-${batch.length}`,
    }));
    const forwarder = new LogForwarder({
      spoolDir: tempDir,
      client: { send },
      now: () => '2026-07-22T08:00:02.000Z',
    });

    await forwarder.flushOnce();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].map((item) => item.snapshotId)).toEqual(['p0-first', 'p1-later']);
    const ack = JSON.parse(await readFile(join(tempDir, 'LYClaw-2026-07-22.snapshot.ack.json'), 'utf8'));
    expect(ack.sentSnapshotIds).toEqual(['p0-first', 'p1-later']);
    expect(ack.lastAckId).toBe('ack-2');
  });

  it('keeps local spool when disabled or unreachable and backs off retries', async () => {
    const spoolFile = join(tempDir, 'LYClaw-2026-07-22.snapshot.jsonl');
    await writeFile(spoolFile, `${JSON.stringify(snapshot('p0-unsent', 'p0'))}\n`);

    const disabledForwarder = new LogForwarder({
      spoolDir: tempDir,
      client: createDisabledLogForwardClient(),
      now: () => '2026-07-22T08:00:00.000Z',
    });
    await disabledForwarder.flushOnce();
    expect(disabledForwarder.getReachability()).toBe('unknown');
    expect(await readFile(spoolFile, 'utf8')).toContain('p0-unsent');

    const send = vi.fn(async () => ({ ok: false as const, reason: 'network' as const }));
    const forwarder = new LogForwarder({
      spoolDir: tempDir,
      client: { send },
      now: vi.fn()
        .mockReturnValueOnce('2026-07-22T08:00:01.000Z')
        .mockReturnValueOnce('2026-07-22T08:00:30.000Z')
        .mockReturnValueOnce('2026-07-22T08:01:02.000Z'),
    });

    await forwarder.flushOnce();
    await forwarder.flushOnce();
    await forwarder.flushOnce();

    expect(forwarder.getReachability()).toBe('unreachable');
    expect(send).toHaveBeenCalledTimes(2);
    expect(await readFile(spoolFile, 'utf8')).toContain('p0-unsent');
  });

  it('schedules a retry when a network failure starts a backoff window', async () => {
    const spoolFile = join(tempDir, 'LYClaw-2026-07-22.snapshot.jsonl');
    await writeFile(spoolFile, `${JSON.stringify(snapshot('retry-automatically', 'p0'))}\n`);
    const send = vi.fn()
      .mockResolvedValueOnce({ ok: false as const, reason: 'network' as const })
      .mockResolvedValueOnce({ ok: true as const });
    let retry: (() => void) | undefined;
    const scheduleRetry = vi.fn((callback: () => void) => {
      retry = callback;
      return () => {};
    });
    let nowIso = '2026-07-22T08:00:00.000Z';
    const options = {
      spoolDir: tempDir,
      client: { send },
      now: () => nowIso,
      scheduleRetry,
    };
    const forwarder = new LogForwarder(options);

    await forwarder.flushOnce();

    expect(scheduleRetry).toHaveBeenCalledWith(expect.any(Function), 60_000);
    nowIso = '2026-07-22T08:01:00.000Z';
    retry?.();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  });

  it('reschedules an automatic retry when the retry flush throws', async () => {
    const spoolFile = join(tempDir, 'LYClaw-2026-07-22.snapshot.jsonl');
    await writeFile(spoolFile, `${JSON.stringify(snapshot('retry-after-throw', 'p0'))}\n`);
    const send = vi.fn()
      .mockResolvedValueOnce({ ok: false as const, reason: 'network' as const })
      .mockRejectedValueOnce(new Error('retry transport crashed'));
    const retries: Array<() => void> = [];
    const scheduleRetry = vi.fn((callback: () => void) => {
      retries.push(callback);
      return () => {};
    });
    let nowIso = '2026-07-22T08:00:00.000Z';
    const forwarder = new LogForwarder({
      spoolDir: tempDir,
      client: { send },
      now: () => nowIso,
      scheduleRetry,
    });

    await forwarder.flushOnce();
    nowIso = '2026-07-22T08:01:00.000Z';
    retries[0]();

    await vi.waitFor(() => expect(scheduleRetry).toHaveBeenCalledTimes(2));
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('retains old P0 snapshots while deleting expired P1 files first', async () => {
    await writeFile(join(tempDir, 'LYClaw-2026-07-01.snapshot.jsonl'), `${JSON.stringify(snapshot('old-p1', 'p1', '2026-07-01T00:00:00.000Z'))}\n`);
    await writeFile(join(tempDir, 'LYClaw-2026-07-02.snapshot.jsonl'), `${JSON.stringify(snapshot('old-p0', 'p0', '2026-07-02T00:00:00.000Z'))}\n`);
    await writeFile(join(tempDir, 'LYClaw-2026-07-22.snapshot.jsonl'), `${JSON.stringify(snapshot('new-p1', 'p1'))}\n`);

    await applySnapshotRetention({
      spoolDir: tempDir,
      now: () => '2026-07-22T08:00:00.000Z',
      retentionDays: 7,
      maxBytes: 1024 * 1024,
    });

    await expect(readFile(join(tempDir, 'LYClaw-2026-07-01.snapshot.jsonl'), 'utf8')).rejects.toThrow();
    await expect(readFile(join(tempDir, 'LYClaw-2026-07-02.snapshot.jsonl'), 'utf8')).resolves.toContain('old-p0');
    await expect(readFile(join(tempDir, 'LYClaw-2026-07-22.snapshot.jsonl'), 'utf8')).resolves.toContain('new-p1');
  });
});
