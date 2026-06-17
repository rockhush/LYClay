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
});
