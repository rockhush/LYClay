import { mkdtemp, mkdir, readFile, stat, utimes, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  recoverOrphanedSessionTranscriptLock,
  recoverStaleSessionAfterEmptyFinal,
} from '@electron/gateway/session-lock-recovery';

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

    expect(result).toMatchObject({
      recovered: false,
      reason: 'session-active',
      lockPath,
      details: expect.objectContaining({ lockPid: 1234, currentPid: 1234, lockBelongsToCurrentGateway: true }),
    });
    expect(await readFile(lockPath, 'utf8')).toContain('"pid":1234');
  });

  it('recovers an active session lock left by a dead previous gateway', async () => {
    const { sessionKey, sessionFile, lockPath } = await writeSessionStore({ status: 'processing' });
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 999999, createdAt: '2026-06-08T01:23:40.000Z' }),
      'utf8',
    );

    const result = await recoverOrphanedSessionTranscriptLock({
      sessionKey,
      openclawDir,
      currentPid: 1234,
      nowMs: Date.parse('2026-06-08T01:24:40.000Z'),
      reason: 'before-user-chat-send',
      logger,
    });

    expect(result).toMatchObject({
      recovered: true,
      lockPath,
      sessionFile,
      lockPid: 999999,
      lockPidAlive: false,
    });
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const sessionsJson = await readFile(path.join(openclawDir, 'agents', 'main', 'sessions', 'sessions.json'), 'utf8');
    expect(sessionsJson).toContain('"status": "stale-recovered"');
    expect(sessionsJson).toContain('"recoveryReason": "before-user-chat-send"');
  });

  it('recovers a stale active same-gateway lock only when supersede recovery is explicitly allowed', async () => {
    const { sessionKey, sessionFile, lockPath } = await writeSessionStore({ status: 'processing' });
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 1234, createdAt: '2026-06-08T01:23:40.000Z' }),
      'utf8',
    );

    const blocked = await recoverOrphanedSessionTranscriptLock({
      sessionKey,
      openclawDir,
      currentPid: 1234,
      nowMs: Date.parse('2026-06-08T01:24:40.000Z'),
      reason: 'terminal-user-chat-final',
      logger,
    });
    expect(blocked).toMatchObject({ recovered: false, reason: 'session-active' });

    const result = await recoverOrphanedSessionTranscriptLock({
      sessionKey,
      openclawDir,
      currentPid: 1234,
      nowMs: Date.parse('2026-06-08T01:24:40.000Z'),
      allowCurrentGatewayActiveLockRecovery: true,
      reason: 'superseded-by-new-user-message',
      logger,
    });

    expect(result).toMatchObject({
      recovered: true,
      lockPath,
      sessionFile,
      lockPid: 1234,
    });
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const sessionsJson = await readFile(path.join(openclawDir, 'agents', 'main', 'sessions', 'sessions.json'), 'utf8');
    expect(sessionsJson).toContain('"status": "stale-recovered"');
    expect(sessionsJson).toContain('"recoveryReason": "superseded-by-new-user-message"');
  });
  it('keeps the lock when it belongs to a live other process', async () => {
    const { sessionKey, lockPath } = await writeSessionStore({ status: 'done' });
    await writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, createdAt: '2026-06-08T01:23:40.000Z' }),
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
      reason: 'lock-owned-by-live-process',
      lockPath,
      details: expect.objectContaining({ lockPid: process.pid, lockPidAlive: true, currentPid: 1234 }),
    });
    expect(await readFile(lockPath, 'utf8')).toContain(`"pid":${process.pid}`);
  });

  it('recovers a stale completed-session lock left by a dead other process', async () => {
    const { sessionKey, lockPath } = await writeSessionStore({ status: 'done' });
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 999999, createdAt: '2026-06-08T01:23:40.000Z' }),
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
      lockPid: 999999,
      lockPidAlive: false,
    });
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recovers a high-confidence stale active session and removes the stale lock', async () => {
    const nowMs = Date.parse('2026-06-08T01:30:00.000Z');
    const oldDate = new Date(nowMs - 10 * 60_000);
    const { sessionKey, sessionFile, lockPath } = await writeSessionStore({ status: 'processing' });
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 999999, createdAt: oldDate.toISOString() }),
      'utf8',
    );
    await utimes(sessionFile, oldDate, oldDate);
    await utimes(lockPath, oldDate, oldDate);

    const result = await recoverStaleSessionAfterEmptyFinal({
      sessionKey,
      openclawDir,
      currentPid: 1234,
      nowMs,
      staleThresholdMs: 60_000,
      hasRecentEmptyFinalNoOutput: true,
      hasTrackedActiveRun: false,
      logger,
    });

    expect(result).toMatchObject({
      ok: true,
      recovered: true,
      sessionKey,
      nextStatus: 'stale-recovered',
      removedLockPath: lockPath,
    });
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(openclawDir, 'agents', 'main', 'sessions', 'sessions.json'), 'utf8'))
      .toContain('"recoveryReason": "stale-empty-final"');
  });

  it('marks a done empty-final session recovered when no transcript lock remains', async () => {
    const nowMs = Date.parse('2026-06-08T01:30:00.000Z');
    const { sessionKey, lockPath } = await writeSessionStore({ status: 'done' });

    const result = await recoverStaleSessionAfterEmptyFinal({
      sessionKey,
      openclawDir,
      currentPid: 1234,
      nowMs,
      staleThresholdMs: 60_000,
      hasRecentEmptyFinalNoOutput: true,
      hasTrackedActiveRun: false,
      logger,
    });

    expect(result).toMatchObject({
      ok: true,
      recovered: true,
      sessionKey,
      previousStatus: 'done',
      nextStatus: 'stale-recovered',
      removedLockPath: null,
    });
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(await readFile(path.join(openclawDir, 'agents', 'main', 'sessions', 'sessions.json'), 'utf8'))[sessionKey])
      .toMatchObject({ status: 'stale-recovered', recoveryReason: 'stale-empty-final' });
  });

  it('refuses stale recovery when the lock belongs to a live process', async () => {
    const nowMs = Date.parse('2026-06-08T01:30:00.000Z');
    const oldDate = new Date(nowMs - 10 * 60_000);
    const { sessionKey, sessionFile, lockPath } = await writeSessionStore({ status: 'processing' });
    await writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, createdAt: oldDate.toISOString() }),
      'utf8',
    );
    await utimes(sessionFile, oldDate, oldDate);
    await utimes(lockPath, oldDate, oldDate);

    const result = await recoverStaleSessionAfterEmptyFinal({
      sessionKey,
      openclawDir,
      currentPid: 1234,
      nowMs,
      staleThresholdMs: 60_000,
      hasRecentEmptyFinalNoOutput: true,
      hasTrackedActiveRun: false,
      logger,
    });

    expect(result).toMatchObject({
      ok: true,
      recovered: false,
      reason: 'lock-owned-by-live-process',
    });
    expect(await readFile(lockPath, 'utf8')).toContain(`"pid":${process.pid}`);
  });

  it('refuses stale recovery when transcript or lock files were recently updated', async () => {
    const nowMs = Date.parse('2026-06-08T01:30:00.000Z');
    const { sessionKey, lockPath } = await writeSessionStore({ status: 'processing' });
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 999999, createdAt: new Date(nowMs - 10 * 60_000).toISOString() }),
      'utf8',
    );

    const result = await recoverStaleSessionAfterEmptyFinal({
      sessionKey,
      openclawDir,
      currentPid: 1234,
      nowMs,
      staleThresholdMs: 60_000,
      hasRecentEmptyFinalNoOutput: true,
      hasTrackedActiveRun: false,
      logger,
    });

    expect(result).toMatchObject({
      ok: true,
      recovered: false,
      reason: 'session-recently-active',
    });
    expect(await readFile(lockPath, 'utf8')).toContain('"pid":999999');
  });
});
