import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const testOpenClawConfigDir = join(tmpdir(), 'clawx-tests', 'historical-digital-employee-agents');
let openClawConfig: Record<string, unknown> = { agents: { list: [] } };

vi.mock('@electron/utils/paths', () => ({
  getOpenClawConfigDir: () => testOpenClawConfigDir,
}));

vi.mock('@electron/utils/logger', () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('@electron/utils/config-mutex', () => ({
  withConfigLock: async <T>(fn: () => Promise<T>) => fn(),
}));

vi.mock('@electron/utils/channel-config', () => ({
  readOpenClawConfig: async () => openClawConfig,
  writeOpenClawConfig: async (config: Record<string, unknown>) => {
    openClawConfig = config;
  },
}));

vi.mock('@electron/utils/digital-employee-storage', () => ({
  listLocalDigitalEmployees: async () => [{
    instanceId: 'recruitment--new',
    marketEmployeeId: 'employee-recruitment-specialist',
    packageId: 'employee-recruitment-specialist',
    packageVersion: '1.0.0',
    name: '招聘数字员工',
    description: '招聘助手',
    tags: [],
    installPath: 'C:\\tmp\\recruitment--new',
    agentId: 'employee-recruitment-specialist-newid01',
    sessionKey: 'agent:employee-recruitment-specialist-newid01:main',
    status: 'active',
    enabled: true,
    warnings: [],
  }],
}));

function writeRetiredSession(agentId: string): void {
  const sessionsDir = join(testOpenClawConfigDir, 'agents', '_retired', agentId, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(
    join(sessionsDir, 'sessions.json'),
    JSON.stringify({
      [`agent:${agentId}:main`]: { id: 'session-history' },
    }),
  );
  writeFileSync(
    join(sessionsDir, 'session-history.jsonl'),
    `${JSON.stringify({
      type: 'message',
      message: { role: 'assistant', content: 'history' },
    })}\n`,
  );
}

describe('historical-digital-employee-agents', () => {
  beforeEach(() => {
    rmSync(testOpenClawConfigDir, { recursive: true, force: true });
    openClawConfig = {
      agents: {
        list: [{
          id: 'employee-recruitment-specialist-newid01',
          name: '招聘数字员工',
          workspace: '~/.openclaw/workspace-employee-recruitment-specialist-newid01',
          agentDir: '~/.openclaw/agents/employee-recruitment-specialist-newid01/agent',
          model: 'custom-sub2api/model-a',
        }],
      },
    };
  });

  afterAll(() => {
    rmSync(testOpenClawConfigDir, { recursive: true, force: true });
  });

  it('restores proxy agent config and sessions for matching retired agent ids', async () => {
    const historicalId = 'employee-recruitment-specialist-8dce23b0';
    writeRetiredSession(historicalId);

    const { reactivateHistoricalDigitalEmployeeAgentsForActive } = await import(
      '@electron/utils/historical-digital-employee-agents'
    );

    const reactivated = await reactivateHistoricalDigitalEmployeeAgentsForActive(
      'employee-recruitment-specialist-newid01',
      '招聘数字员工',
    );

    expect(reactivated).toEqual([historicalId]);
    const entries = (openClawConfig.agents as { list: Array<Record<string, unknown>> }).list;
    const proxy = entries.find((entry) => entry.id === historicalId);
    expect(proxy).toMatchObject({
      id: historicalId,
      workspace: '~/.openclaw/workspace-employee-recruitment-specialist-newid01',
      model: 'custom-sub2api/model-a',
    });

    const activeSessionsDir = join(testOpenClawConfigDir, 'agents', historicalId, 'sessions');
    expect(existsSync(join(activeSessionsDir, 'session-history.jsonl'))).toBe(true);
  });

  it('prepares chat.send by ensuring proxy config for historical session keys', async () => {
    const historicalId = 'employee-recruitment-specialist-8dce23b0';
    writeRetiredSession(historicalId);

    const { prepareHistoricalDigitalEmployeeChatSend } = await import(
      '@electron/utils/historical-digital-employee-agents'
    );

    const reloadGateway = vi.fn(async () => undefined);
    await prepareHistoricalDigitalEmployeeChatSend({
      sessionKey: `agent:${historicalId}:main`,
      executeAsAgentId: 'employee-recruitment-specialist-newid01',
      executedByAgentName: '招聘数字员工',
      message: 'hello',
    }, { reloadGateway });

    const entries = (openClawConfig.agents as { list: Array<Record<string, unknown>> }).list;
    expect(entries.some((entry) => entry.id === historicalId)).toBe(true);
    expect(reloadGateway).toHaveBeenCalledTimes(1);
  });
});
