import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';

const sendJsonMock = vi.fn();
const testOpenClawConfigDir = join(tmpdir(), 'clawx-tests', 'sessions-transcript-redaction');
const providerToken = 'sk-abcdefghijklmnopqrstuvwxyz1234567890';
const bearer = 'Bearer abcdefghijklmnopqrstuvwxyz123456';

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

function writeTranscript(agentId: string, sessionId: string, entries: unknown[]): void {
  const sessionsDir = join(testOpenClawConfigDir, 'agents', agentId, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    join(sessionsDir, `${sessionId}.jsonl`),
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

describe('session transcript redaction', () => {
  beforeEach(() => {
    sendJsonMock.mockReset();
    rmSync(testOpenClawConfigDir, { recursive: true, force: true });
  });

  afterAll(() => {
    rmSync(testOpenClawConfigDir, { recursive: true, force: true });
  });

  it('redacts session list previews before returning them to the renderer', async () => {
    const sessionsDir = join(testOpenClawConfigDir, 'agents', 'main', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, 'sessions.json'),
      JSON.stringify({
        'agent:main:main': {
          id: 'main-session',
          label: `fallback api_key=${providerToken}`,
        },
      }),
    );
    writeTranscript('main', 'main-session', [
      {
        type: 'message',
        message: {
          role: 'user',
          content: `preview api_key=${providerToken}`,
        },
      },
    ]);

    const payload = await request('/api/sessions/list-local?agentId=main&includePreviews=1');
    const serialized = JSON.stringify(payload);

    expect(serialized).toContain('api_key=[REDACTED]');
    expect(serialized).not.toContain(providerToken);
  });

  it('skips heartbeat poll messages when deriving session list previews', async () => {
    const sessionsDir = join(testOpenClawConfigDir, 'agents', 'main', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, 'sessions.json'),
      JSON.stringify({
        'agent:main:main': {
          id: 'heartbeat-session',
        },
      }),
    );
    writeTranscript('main', 'heartbeat-session', [
      {
        type: 'message',
        message: {
          role: 'user',
          content: '[OpenClaw heartbeat poll]',
        },
      },
      {
        type: 'message',
        message: {
          role: 'user',
          content: '真正的用户问题',
        },
      },
    ]);

    const payload = await request('/api/sessions/list-local?agentId=main&includePreviews=1');
    const serialized = JSON.stringify(payload);

    expect(serialized).toContain('真正的用户问题');
    expect(serialized).not.toContain('[OpenClaw heartbeat poll]');
  });

  it('keeps normal session previews that mention the heartbeat label', async () => {
    const sessionsDir = join(testOpenClawConfigDir, 'agents', 'main', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, 'sessions.json'),
      JSON.stringify({
        'agent:main:main': {
          id: 'heartbeat-question-session',
        },
      }),
    );
    writeTranscript('main', 'heartbeat-question-session', [
      {
        type: 'message',
        message: {
          role: 'user',
          content: '为什么我会看到 [OpenClaw heartbeat poll] 这个消息？',
        },
      },
    ]);

    const payload = await request('/api/sessions/list-local?agentId=main&includePreviews=1');
    const serialized = JSON.stringify(payload);

    expect(serialized).toContain('为什么我会看到 [OpenClaw heartbeat poll] 这个消息？');
  });

  it('redacts nested messages and prompt errors returned from local history', async () => {
    const sessionsDir = join(testOpenClawConfigDir, 'agents', 'main', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, 'sessions.json'),
      JSON.stringify({
        'agent:main:main': { id: 'history-session' },
      }),
    );
    writeTranscript('main', 'history-session', [
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: `Authorization: ${bearer}` },
            {
              type: 'toolCall',
              arguments: {
                token: 'short-sensitive-value',
                totalTokens: 42,
              },
            },
          ],
        },
      },
      {
        type: 'custom',
        customType: 'openclaw:prompt-error',
        data: {
          error: `api_key=${providerToken}`,
        },
      },
    ]);

    const payload = await request('/api/sessions/history-local?sessionKey=agent%3Amain%3Amain');
    const serialized = JSON.stringify(payload);

    expect(serialized).toContain('Bearer [REDACTED]');
    expect(serialized).toContain('"token":"[REDACTED]"');
    expect(serialized).toContain('"totalTokens":42');
    expect(serialized).toContain('api_key=[REDACTED]');
    expect(serialized).not.toContain('short-sensitive-value');
    expect(serialized).not.toContain(providerToken);
    expect(serialized).not.toContain(bearer);
  });

  it('attaches jsonl envelope timestamps to history-local messages', async () => {
    const sessionsDir = join(testOpenClawConfigDir, 'agents', 'main', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, 'sessions.json'),
      JSON.stringify({
        'agent:main:main': {
          id: 'main-session',
        },
      }),
    );
    writeTranscript('main', 'main-session', [
      {
        type: 'message',
        timestamp: '2026-06-22T03:09:01.083Z',
        message: {
          role: 'assistant',
          id: 'a1',
          content: [{ type: 'thinking', thinking: 'phase 1' }],
        },
      },
      {
        type: 'message',
        timestamp: '2026-06-22T03:09:52.702Z',
        message: {
          role: 'assistant',
          id: 'a2',
          content: [{ type: 'thinking', thinking: 'phase 2' }],
        },
      },
    ]);

    const payload = await request('/api/sessions/history-local?sessionKey=agent%3Amain%3Amain');
    const messages = payload.messages as Array<{ timestamp?: number }>;
    expect(messages[0]?.timestamp).toBe(1782097741.083);
    expect(messages[1]?.timestamp).toBe(1782097792.702);
  });

  it('strips trailing NO_REPLY from history-local assistant messages', async () => {
    const sessionsDir = join(testOpenClawConfigDir, 'agents', 'main', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, 'sessions.json'),
      JSON.stringify({
        'agent:main:main': {
          id: 'main-session',
        },
      }),
    );
    writeTranscript('main', 'main-session', [
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '面试题库已生成。\n\nNO_REPLY' }],
        },
      },
    ]);

    const payload = await request('/api/sessions/history-local?sessionKey=agent%3Amain%3Amain');
    const messages = payload.messages as Array<{ role?: string; content?: Array<{ text?: string }> }>;
    expect(messages[0]?.content?.[0]?.text).toBe('面试题库已生成。');
    expect(JSON.stringify(payload)).not.toContain('NO_REPLY');
  });

  it('falls back to sessionKey transcript when indexed UUID file is missing', async () => {
    const sessionKey = 'agent:main:session-1782866895788';
    const uuidId = '06ff1d88-2ce5-4be9-a688-1182aa490c1d';
    const sessionsDir = join(testOpenClawConfigDir, 'agents', 'main', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, 'sessions.json'),
      JSON.stringify({
        [sessionKey]: { id: uuidId },
      }),
    );
    writeTranscript('main', 'session-1782866895788', [
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '昨天的聊天总结' }],
        },
      },
    ]);

    const payload = await request(`/api/sessions/history-local?sessionKey=${encodeURIComponent(sessionKey)}`);
    const messages = payload.messages as Array<{ content?: Array<{ text?: string }> }>;

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content?.[0]?.text).toBe('昨天的聊天总结');
  });

  it('loads history from retired archive when active agent sessions were removed', async () => {
    const agentId = 'employee-recruitment-specialist-retired';
    const sessionKey = `agent:${agentId}:main`;
    const sessionId = 'session-retired-archive';
    const retiredDir = join(testOpenClawConfigDir, 'agents', '_retired', agentId, 'sessions');
    mkdirSync(retiredDir, { recursive: true });
    writeFileSync(
      join(retiredDir, 'sessions.json'),
      JSON.stringify({
        [sessionKey]: { id: sessionId },
      }),
    );
    writeFileSync(
      join(retiredDir, `${sessionId}.jsonl`),
      `${JSON.stringify({
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'retired session history' }],
        },
      })}\n`,
    );

    const payload = await request(`/api/sessions/history-local?sessionKey=${encodeURIComponent(sessionKey)}`);
    const messages = payload.messages as Array<{ content?: Array<{ text?: string }> }>;

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content?.[0]?.text).toBe('retired session history');
  });

  it('prefers indexed UUID transcript over sessionKey fallback when both exist', async () => {
    const sessionKey = 'agent:main:session-prefer-uuid';
    const uuidId = 'uuid-prefer-over-session-key';
    const sessionsDir = join(testOpenClawConfigDir, 'agents', 'main', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, 'sessions.json'),
      JSON.stringify({
        [sessionKey]: { id: uuidId },
      }),
    );
    writeTranscript('main', uuidId, [
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'from UUID file' }],
        },
      },
    ]);
    writeTranscript('main', 'session-prefer-uuid', [
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'from session-key file' }],
        },
      },
    ]);

    const payload = await request(`/api/sessions/history-local?sessionKey=${encodeURIComponent(sessionKey)}`);
    const messages = payload.messages as Array<{ content?: Array<{ text?: string }> }>;

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content?.[0]?.text).toBe('from UUID file');
  });

  it('redacts nested child-agent transcript messages before returning them', async () => {
    writeTranscript('worker', 'child-session', [
      {
        type: 'message',
        message: {
          role: 'tool',
          content: [{ type: 'text', text: `Authorization: ${bearer}` }],
          details: {
            password: 'tiny-but-private',
          },
        },
      },
    ]);

    const payload = await request('/api/sessions/transcript?agentId=worker&sessionId=child-session');
    const serialized = JSON.stringify(payload);

    expect(serialized).toContain('Bearer [REDACTED]');
    expect(serialized).toContain('"password":"[REDACTED]"');
    expect(serialized).not.toContain('tiny-but-private');
    expect(serialized).not.toContain(bearer);
  });

  it('reads list-local and history-local from retired agent session archives', async () => {
    const agentId = 'employee-recruitment-specialist-128348c9';
    const sessionKey = `agent:${agentId}:session-retired`;
    const retiredSessionsDir = join(
      testOpenClawConfigDir,
      'agents',
      '_retired',
      agentId,
      'sessions',
    );
    mkdirSync(retiredSessionsDir, { recursive: true });
    writeFileSync(
      join(retiredSessionsDir, 'sessions.json'),
      JSON.stringify({
        [sessionKey]: {
          id: 'retired-session',
        },
      }),
    );
    writeFileSync(
      join(retiredSessionsDir, 'retired-session.jsonl'),
      `${JSON.stringify({
        type: 'message',
        message: {
          role: 'assistant',
          content: 'retired archive history',
        },
      })}\n`,
    );

    const listPayload = await request(`/api/sessions/list-local?agentId=${encodeURIComponent(agentId)}&includePreviews=1`);
    const sessions = listPayload.sessions as Array<{ key?: string; label?: string }>;
    expect(sessions.some((session) => session.key === sessionKey)).toBe(true);

    const historyPayload = await request(`/api/sessions/history-local?sessionKey=${encodeURIComponent(sessionKey)}`);
    const messages = historyPayload.messages as Array<{ content?: string }>;
    expect(messages[0]?.content).toBe('retired archive history');
  });
});
