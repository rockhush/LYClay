import { mkdtemp, mkdir, readFile, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { recoverOrphanedSessionTranscriptLock } from '@electron/gateway/session-lock-recovery';

describe('session transcript lock recovery', () => {
  let openclawDir: string;
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    openclawDir = await mkdtemp(path.join(tmpdir(), 'clawx-session-lock-'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function writeSessionStore(entry: Record<string, unknown>): Promise<{ sessionKey: string; sessionFile: string; lockPath: string }> {
    const sessionKey = 'agent:main:session-123';
    const sessionsDir = path.join(openclawDir, 'agents', 'main', 'sessions');
    const sessionFile = path.join(sessionsDir, 'abc.jsonl');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(sessionFile, '', 'utf8');
    await writeFile(
      path.join(sessionsDir, 'sessions.json'),
      JSON.stringify({
        [sessionKey]: {
          sessionId: 'abc',
          sessionFile,
          ...entry,
        },
      }),
      'utf8',
    );
    return { sessionKey, sessionFile, lockPath: `${sessionFile}.lock` };
  }

  it('removes a stale same-process transcript lock for a completed session', async () => {
    const { sessionKey, sessionFile, lockPath } = await writeSessionStore({ status: 'done' });
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 1234, createdAt: '2026-06-08T01:23:40.000Z' }),
      'utf8',
    );

    const result = await recoverOrphanedSessionTranscriptLock({
      sessionKey,
      openclawDir,
      currentPid: 1234,
      nowMs: Date.parse('2026-06-08T01:24:40.000Z'),
      reason: 'test',
      logger,
    });

    expect(result).toMatchObject({
      recovered: true,
      lockPath,
      sessionFile,
      lockAgeMs: 60_000,
    });
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(logger.warn).toHaveBeenCalledWith(
      '[gateway:session-lock-recovery] removed orphaned session transcript lock',
      expect.objectContaining({ sessionKey, lockPath, reason: 'test' }),
    );
  });

  it('keeps the lock when the session is still active', async () => {
    const { sessionKey, lockPath } = await writeSessionStore({ status: 'processing' });
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 1234, createdAt: '2026-06-08T01:23:40.000Z' }),
      'utf8',
    );

    const result = await recoverOrphanedSessionTranscriptLock({
      sessionKey,
      openclawDir,
      currentPid: 1234,
      nowMs: Date.parse('2026-06-08T01:24:40.000Z'),
      reason: 'test',
      logger,
    });

    expect(result).toEqual({ recovered: false, reason: 'session-active' });
    expect(await readFile(lockPath, 'utf8')).toContain('"pid":1234');
  });

  it('keeps the lock when it belongs to another process', async () => {
    const { sessionKey, lockPath } = await writeSessionStore({ status: 'done' });
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 5678, createdAt: '2026-06-08T01:23:40.000Z' }),
      'utf8',
    );

    const result = await recoverOrphanedSessionTranscriptLock({
      sessionKey,
      openclawDir,
      currentPid: 1234,
      nowMs: Date.parse('2026-06-08T01:24:40.000Z'),
      reason: 'test',
      logger,
    });

    expect(result).toMatchObject({
      recovered: false,
      reason: 'lock-owned-by-other-process',
      lockPath,
    });
    expect(await readFile(lockPath, 'utf8')).toContain('"pid":5678');
  });
});
