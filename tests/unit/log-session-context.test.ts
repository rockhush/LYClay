import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveLogSessionContext } from '@electron/utils/log-session-context';

const SESSION_KEY = 'agent:main:session-1785285317125';
const FILE_UUID = '977e72a4-3784-488c-9919-2284dad5a1c3';
const FIELD_UUID = '842abee1-0ab8-4b3a-adb2-c3edee444233';
const ID_UUID = '8cceb8ca-8eb6-4a25-99b7-9a62b5dfb0f2';

let openClawDir: string;

async function writeSessionsIndex(agentId: string, entries: Record<string, unknown>): Promise<void> {
  const sessionsDir = join(openClawDir, 'agents', agentId, 'sessions');
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(join(sessionsDir, 'sessions.json'), JSON.stringify(entries), 'utf8');
}

beforeEach(async () => {
  openClawDir = await mkdtemp(join(tmpdir(), 'lyclaw-log-session-context-'));
});

afterEach(async () => {
  await rm(openClawDir, { recursive: true, force: true });
});

describe('resolveLogSessionContext', () => {
  it.each([
    `${FILE_UUID}.jsonl`,
    `${FILE_UUID}.deleted.jsonl`,
    `${FILE_UUID}.jsonl.reset.2026-07-29T08-00-00.000Z`,
    `${FILE_UUID}.deleted.jsonl.reset.2026-07-29T08-00-00.000Z`,
  ])('resolves the transcript UUID from sessionFile %s', async (sessionFile) => {
    await writeSessionsIndex('main', {
      [SESSION_KEY]: {
        sessionFile: join(openClawDir, 'agents', 'main', 'sessions', sessionFile),
        sessionId: FIELD_UUID,
        id: ID_UUID,
      },
    });

    await expect(resolveLogSessionContext(SESSION_KEY, { openClawDir })).resolves.toEqual({
      sessionKey: SESSION_KEY,
      sessionId: FILE_UUID,
    });
  });

  it('falls back from sessionFile to sessionId and then id', async () => {
    await writeSessionsIndex('main', {
      [SESSION_KEY]: { sessionFile: 'not-a-uuid.jsonl', sessionId: FIELD_UUID, id: ID_UUID },
      'agent:main:session-id-fallback': { sessionId: 'not-a-uuid', id: ID_UUID },
    });

    await expect(resolveLogSessionContext(SESSION_KEY, { openClawDir })).resolves.toEqual({
      sessionKey: SESSION_KEY,
      sessionId: FIELD_UUID,
    });
    await expect(resolveLogSessionContext('agent:main:session-id-fallback', { openClawDir })).resolves.toEqual({
      sessionKey: 'agent:main:session-id-fallback',
      sessionId: ID_UUID,
    });
  });

  it('keeps sessionKey and omits sessionId when no valid UUID exists', async () => {
    await writeSessionsIndex('main', {
      [SESSION_KEY]: { sessionFile: 'session-1785285317125.jsonl', sessionId: 'invalid', id: 123 },
    });

    await expect(resolveLogSessionContext(SESSION_KEY, { openClawDir })).resolves.toEqual({
      sessionKey: SESSION_KEY,
    });
    await expect(resolveLogSessionContext('agent:main:missing', { openClawDir })).resolves.toEqual({
      sessionKey: 'agent:main:missing',
    });
    await expect(resolveLogSessionContext('unsupported-session-key', { openClawDir })).resolves.toEqual({
      sessionKey: 'unsupported-session-key',
    });
  });

  it('degrades without throwing when sessions.json is absent or malformed', async () => {
    await expect(resolveLogSessionContext(SESSION_KEY, { openClawDir })).resolves.toEqual({
      sessionKey: SESSION_KEY,
    });

    const sessionsDir = join(openClawDir, 'agents', 'main', 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(join(sessionsDir, 'sessions.json'), '{broken', 'utf8');

    await expect(resolveLogSessionContext(SESSION_KEY, { openClawDir })).resolves.toEqual({
      sessionKey: SESSION_KEY,
    });
  });

  it('uses only the agent encoded in sessionKey', async () => {
    const workerKey = 'agent:worker:session-1785285317125';
    await writeSessionsIndex('main', {
      [workerKey]: { sessionFile: `${FIELD_UUID}.jsonl` },
    });
    await writeSessionsIndex('worker', {
      [workerKey]: { sessionFile: `${ID_UUID}.jsonl` },
    });

    await expect(resolveLogSessionContext(workerKey, { openClawDir })).resolves.toEqual({
      sessionKey: workerKey,
      sessionId: ID_UUID,
    });
  });

  it('returns an empty context when no sessionKey is available', async () => {
    await expect(resolveLogSessionContext(undefined, { openClawDir })).resolves.toEqual({});
    await expect(resolveLogSessionContext('   ', { openClawDir })).resolves.toEqual({});
  });
});
