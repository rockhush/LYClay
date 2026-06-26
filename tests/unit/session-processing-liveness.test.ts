import { mkdtemp, mkdir, utimes, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';

import { isSessionProcessingLiveOnDisk } from '@electron/gateway/session-processing-liveness';

describe('session-processing-liveness', () => {
  let openclawDir: string;

  beforeEach(async () => {
    openclawDir = await mkdtemp(path.join(tmpdir(), 'clawx-session-live-'));
  });

  async function writeSessionStore(params: {
    status: string;
    sessionKey?: string;
    sessionFileName?: string;
    withLock?: boolean;
    lockPid?: number;
    transcriptAgeMs?: number;
  }): Promise<{ sessionKey: string; sessionFile: string }> {
    const sessionKey = params.sessionKey ?? 'agent:main:session-123';
    const sessionsDir = path.join(openclawDir, 'agents', 'main', 'sessions');
    const sessionFileName = params.sessionFileName ?? 'abc.jsonl';
    const sessionFile = path.join(sessionsDir, sessionFileName);
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(sessionFile, '{"type":"message"}\n', 'utf8');

    const nowMs = Date.now();
    const transcriptAgeMs = params.transcriptAgeMs ?? 0;
    const transcriptAt = new Date(nowMs - transcriptAgeMs);
    await utimes(sessionFile, transcriptAt, transcriptAt);

    await writeFile(
      path.join(sessionsDir, 'sessions.json'),
      JSON.stringify({
        [sessionKey]: {
          sessionId: 'abc',
          sessionFile: sessionFileName,
          status: params.status,
        },
      }),
      'utf8',
    );

    if (params.withLock) {
      const lockPath = `${sessionFile}.lock`;
      await writeFile(
        lockPath,
        JSON.stringify({ pid: params.lockPid ?? process.pid, createdAt: new Date(nowMs).toISOString() }),
        'utf8',
      );
      await utimes(lockPath, new Date(nowMs), new Date(nowMs));
    }

    return { sessionKey, sessionFile };
  }

  it('treats tracked active runs as live without reading disk', async () => {
    const live = await isSessionProcessingLiveOnDisk({
      sessionKey: 'agent:main:session-999',
      openclawDir,
      hasTrackedActiveRun: true,
    });
    expect(live).toBe(true);
  });

  it('ignores stale sessions.json processing status with old transcript and no lock', async () => {
    const { sessionKey } = await writeSessionStore({
      status: 'processing',
      transcriptAgeMs: 7 * 24 * 60 * 60_000,
    });

    const live = await isSessionProcessingLiveOnDisk({
      sessionKey,
      openclawDir,
      hasTrackedActiveRun: false,
    });

    expect(live).toBe(false);
  });

  it('keeps processing status when a live lock exists', async () => {
    const { sessionKey } = await writeSessionStore({
      status: 'processing',
      transcriptAgeMs: 7 * 24 * 60 * 60_000,
      withLock: true,
      lockPid: process.pid,
    });

    const live = await isSessionProcessingLiveOnDisk({
      sessionKey,
      openclawDir,
      hasTrackedActiveRun: false,
      currentPid: process.pid,
    });

    expect(live).toBe(true);
  });

  it('keeps processing status when transcript was updated recently', async () => {
    const { sessionKey } = await writeSessionStore({
      status: 'processing',
      transcriptAgeMs: 30_000,
    });

    const live = await isSessionProcessingLiveOnDisk({
      sessionKey,
      openclawDir,
      hasTrackedActiveRun: false,
    });

    expect(live).toBe(true);
  });
});
