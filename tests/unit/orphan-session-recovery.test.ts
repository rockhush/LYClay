import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  clearOrphanRecoveryCacheForTests,
  inferSessionKeyFromOrphanFile,
  isRecoverableOrphanSessionKey,
  isSessionActivityOlderThanDays,
  listOrphanArchivedSessions,
} from '../../electron/utils/orphan-session-recovery';

const sendJsonMock = vi.fn();
const testOpenClawConfigDir = join(tmpdir(), 'clawx-tests', 'orphan-session-recovery');

vi.mock('@electron/api/route-utils', () => ({
  parseJsonBody: vi.fn(),
  sendJson: (...args: unknown[]) => sendJsonMock(...args),
}));

vi.mock('@electron/utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@electron/utils/paths', () => ({
  getOpenClawConfigDir: () => testOpenClawConfigDir,
}));

vi.mock('@electron/utils/agent-config', () => ({
  listAgentsSnapshot: vi.fn(async () => ({ agents: [], defaultModelRef: undefined })),
}));

function writeTranscript(agentId: string, fileName: string, entries: unknown[]): void {
  const sessionsDir = join(testOpenClawConfigDir, 'agents', agentId, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    join(sessionsDir, fileName.endsWith('.jsonl') ? fileName : `${fileName}.jsonl`),
    `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
  );
}

async function request(path: string): Promise<Record<string, unknown>> {
  const { handleSessionRoutes } = await import('@electron/api/routes/sessions');
  const handled = await handleSessionRoutes(
    { method: 'GET' } as IncomingMessage,
    {} as ServerResponse,
    new URL(`http://127.0.0.1:13210${path}`),
    {} as never,
  );

  expect(handled).toBe(true);
  return sendJsonMock.mock.calls.at(-1)?.[2] as Record<string, unknown>;
}

async function postRequest(path: string, body: unknown): Promise<Record<string, unknown>> {
  const { parseJsonBody } = await import('@electron/api/route-utils');
  vi.mocked(parseJsonBody).mockResolvedValue(body);

  const { handleSessionRoutes } = await import('@electron/api/routes/sessions');
  const handled = await handleSessionRoutes(
    { method: 'POST' } as IncomingMessage,
    {} as ServerResponse,
    new URL(`http://127.0.0.1:13210${path}`),
    {} as never,
  );

  expect(handled).toBe(true);
  return sendJsonMock.mock.calls.at(-1)?.[2] as Record<string, unknown>;
}

describe('orphan session recovery', () => {
  beforeEach(() => {
    sendJsonMock.mockReset();
    clearOrphanRecoveryCacheForTests();
    rmSync(testOpenClawConfigDir, { recursive: true, force: true });
  });

  afterAll(() => {
    rmSync(testOpenClawConfigDir, { recursive: true, force: true });
  });

  it('infers session keys from orphan transcript filenames', () => {
    expect(inferSessionKeyFromOrphanFile('main', 'session-1782866895788.jsonl'))
      .toBe('agent:main:session-1782866895788');
    expect(inferSessionKeyFromOrphanFile('main', 'main-session.deleted.jsonl')).toBeNull();
  });

  it('rejects non-user-facing orphan session keys', () => {
    expect(isRecoverableOrphanSessionKey('agent:main:main')).toBe(false);
    expect(isRecoverableOrphanSessionKey('agent:main:subagent:abc')).toBe(false);
    expect(isRecoverableOrphanSessionKey('agent:main:scheduled-task:job-a:run-a')).toBe(false);
    expect(isRecoverableOrphanSessionKey('agent:main:session-old')).toBe(true);
  });

  it('uses the same >14 day cutoff as sidebar buckets', () => {
    const nowMs = Date.parse('2026-06-10T12:00:00+08:00');
    const withinTwoWeeks = Date.parse('2026-06-02T18:37:00+08:00');
    const olderThanTwoWeeks = Date.parse('2026-05-20T12:00:00+08:00');

    expect(isSessionActivityOlderThanDays(withinTwoWeeks, nowMs, 14)).toBe(false);
    expect(isSessionActivityOlderThanDays(olderThanTwoWeeks, nowMs, 14)).toBe(true);
  });

  it('recovers only orphan transcripts older than two weeks', async () => {
    const sessionsDir = join(testOpenClawConfigDir, 'agents', 'main', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    const sessionsJson = { 'agent:main:recent': { id: 'recent-session' } };
    writeFileSync(join(sessionsDir, 'sessions.json'), JSON.stringify(sessionsJson));

    writeTranscript('main', 'recent-session', [
      {
        type: 'message',
        message: { role: 'user', content: 'recent chat', timestamp: Date.parse('2026-06-09T12:00:00+08:00') / 1000 },
      },
    ]);
    writeTranscript('main', 'session-archived-old', [
      {
        type: 'message',
        message: { role: 'user', content: 'archived chat', timestamp: Date.parse('2026-05-20T12:00:00+08:00') / 1000 },
      },
    ]);
    writeTranscript('main', 'session-archived-recent', [
      {
        type: 'message',
        message: { role: 'user', content: 'still recent orphan', timestamp: Date.parse('2026-06-09T12:00:00+08:00') / 1000 },
      },
    ]);

    const nowMs = Date.parse('2026-06-10T12:00:00+08:00');
    const recovered = await listOrphanArchivedSessions({
      sessionsDir,
      agentId: 'main',
      sessionsJson,
      minAgeDays: 14,
      nowMs,
    });

    expect(recovered.map((session) => session.key)).toEqual(['agent:main:session-archived-old']);
    expect(recovered[0]?.firstUserMessagePreview).toBe('archived chat');
  });

  it('strips cron id prefixes from recovered session previews', async () => {
    const sessionsDir = join(testOpenClawConfigDir, 'agents', 'main', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'sessions.json'), JSON.stringify({}));
    writeTranscript('main', 'session-cron-old', [
      {
        type: 'message',
        message: {
          role: 'user',
          content: '[cron:98e2cd2f-fcbb-488f-8381-35cd1588a685] 游戏1 是时候去打两把游戏了',
          timestamp: Date.parse('2026-05-01T12:00:00+08:00') / 1000,
        },
      },
    ]);

    const nowMs = Date.parse('2026-06-10T12:00:00+08:00');
    const recovered = await listOrphanArchivedSessions({
      sessionsDir,
      agentId: 'main',
      sessionsJson: {},
      minAgeDays: 14,
      nowMs,
    });

    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.firstUserMessagePreview).toBe('游戏1 是时候去打两把游戏了');
  });

  it('exposes recovered sessions through list-orphan-recovery API', async () => {
    const sessionsDir = join(testOpenClawConfigDir, 'agents', 'main', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'sessions.json'), JSON.stringify({}));
    writeTranscript('main', 'session-api-old', [
      {
        type: 'message',
        message: { role: 'user', content: 'api recovered chat', timestamp: Date.parse('2026-05-01T12:00:00+08:00') / 1000 },
      },
    ]);

    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-06-10T12:00:00+08:00'));

    const payload = await request('/api/sessions/list-orphan-recovery?agentId=main&minAgeDays=14');
    const sessions = payload.sessions as Array<{ key?: string; firstUserMessagePreview?: string }>;

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.key).toBe('agent:main:session-api-old');
    expect(sessions[0]?.firstUserMessagePreview).toBe('api recovered chat');

    vi.useRealTimers();
  });

  it('loads history for recovered orphan sessions via sessionKey fallback', async () => {
    const sessionKey = 'agent:main:session-recovered-history';
    writeTranscript('main', 'session-recovered-history', [
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'history from orphan transcript' }],
        },
      },
    ]);

    const payload = await request(`/api/sessions/history-local?sessionKey=${encodeURIComponent(sessionKey)}`);
    const messages = payload.messages as Array<{ content?: Array<{ text?: string }> }>;

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content?.[0]?.text).toBe('history from orphan transcript');
  });

  it('deletes orphan-only sessions via sessionKey transcript fallback and prevents re-recovery', async () => {
    const sessionsDir = join(testOpenClawConfigDir, 'agents', 'main', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'sessions.json'), JSON.stringify({}));
    writeTranscript('main', 'session-delete-orphan', [
      {
        type: 'message',
        message: {
          role: 'user',
          content: 'delete me later',
          timestamp: Date.parse('2026-05-01T12:00:00+08:00') / 1000,
        },
      },
    ]);

    const nowMs = Date.parse('2026-06-10T12:00:00+08:00');
    const sessionKey = 'agent:main:session-delete-orphan';
    const beforeDelete = await listOrphanArchivedSessions({
      sessionsDir,
      agentId: 'main',
      sessionsJson: {},
      minAgeDays: 14,
      nowMs,
    });
    expect(beforeDelete.map((session) => session.key)).toEqual([sessionKey]);

    const deletePayload = await postRequest('/api/sessions/delete', { sessionKey });
    expect(deletePayload.success).toBe(true);
    expect(existsSync(join(sessionsDir, 'session-delete-orphan.jsonl'))).toBe(false);
    expect(existsSync(join(sessionsDir, 'session-delete-orphan.deleted.jsonl'))).toBe(true);

    const afterDelete = await listOrphanArchivedSessions({
      sessionsDir,
      agentId: 'main',
      sessionsJson: {},
      minAgeDays: 14,
      nowMs,
    });
    expect(afterDelete).toEqual([]);
  });
});
