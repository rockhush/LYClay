import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const testOpenClawConfigDir = join(tmpdir(), 'clawx-tests', 'retired-agent-sessions');

vi.mock('@electron/utils/paths', () => ({
  getOpenClawConfigDir: () => testOpenClawConfigDir,
}));

vi.mock('@electron/utils/logger', () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

function writeActiveSession(agentId: string, sessionKey: string, message: string): void {
  const sessionsDir = join(testOpenClawConfigDir, 'agents', agentId, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  const sessionId = 'session-archive-test';
  writeFileSync(
    join(sessionsDir, 'sessions.json'),
    JSON.stringify({
      [sessionKey]: {
        id: sessionId,
      },
    }),
  );
  writeFileSync(
    join(sessionsDir, `${sessionId}.jsonl`),
    `${JSON.stringify({
      type: 'message',
      message: { role: 'assistant', content: message },
    })}\n`,
  );
}

describe('retired-agent-sessions', () => {
  beforeEach(() => {
    rmSync(testOpenClawConfigDir, { recursive: true, force: true });
  });

  afterAll(() => {
    rmSync(testOpenClawConfigDir, { recursive: true, force: true });
  });

  it('archives active sessions before removal and resolves retired directory afterward', async () => {
    const agentId = 'employee-recruitment-specialist-128348c9';
    const sessionKey = `agent:${agentId}:main`;
    writeActiveSession(agentId, sessionKey, 'archived history');

    const {
      archiveAgentSessionsBeforeRemoval,
      getActiveAgentSessionsDir,
      getRetiredAgentSessionsDir,
      resolveAgentSessionsDir,
    } = await import('@electron/utils/retired-agent-sessions');

    await expect(archiveAgentSessionsBeforeRemoval(agentId)).resolves.toBe(true);
    rmSync(getActiveAgentSessionsDir(agentId), { recursive: true, force: true });

    await expect(resolveAgentSessionsDir(agentId)).resolves.toBe(getRetiredAgentSessionsDir(agentId));
    const archivedJsonl = join(getRetiredAgentSessionsDir(agentId), 'session-archive-test.jsonl');
    expect(existsSync(archivedJsonl)).toBe(true);
  });

  it('prefers active sessions directory when both active and retired copies exist', async () => {
    const agentId = 'employee-recruitment-specialist-active';
    writeActiveSession(agentId, `agent:${agentId}:main`, 'active history');

    const {
      archiveAgentSessionsBeforeRemoval,
      getActiveAgentSessionsDir,
      resolveAgentSessionsDir,
    } = await import('@electron/utils/retired-agent-sessions');

    await archiveAgentSessionsBeforeRemoval(agentId);
    await expect(resolveAgentSessionsDir(agentId)).resolves.toBe(getActiveAgentSessionsDir(agentId));
  });

  it('does not archive main agent sessions', async () => {
    writeActiveSession('main', 'agent:main:main', 'main history');
    const { archiveAgentSessionsBeforeRemoval } = await import('@electron/utils/retired-agent-sessions');

    await expect(archiveAgentSessionsBeforeRemoval('main')).resolves.toBe(false);
  });
});
