import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const testOpenClawConfigDir = join(tmpdir(), 'lyclaw-tests', 'cron-supervisor-delivery');

vi.mock('../../electron/utils/paths', () => ({
  getOpenClawConfigDir: () => testOpenClawConfigDir,
}));

describe('cron supervisor delivery', () => {
  beforeEach(() => {
    rmSync(testOpenClawConfigDir, { recursive: true, force: true });
    mkdirSync(testOpenClawConfigDir, { recursive: true });
  });

  it('inherits external delivery config for manual streaming triggers', async () => {
    const { triggerCronJobStreaming } = await import('../../electron/gateway/cron-supervisor');
    const cronRunParams: Record<string, unknown>[] = [];
    const rpc = vi.fn(async (method: string, params: unknown) => {
      if (method === 'cron.list') {
        return {
          jobs: [{
            id: 'job-dingtalk',
            agentId: 'main',
            name: 'Daily report',
            payload: { kind: 'agentTurn', message: 'Summarize today' },
            delivery: {
              mode: 'announce',
              channel: 'dingtalk',
              accountId: 'dingtalk-main',
              to: 'cidDailyReport=',
            },
          }],
        };
      }
      if (method === 'cron.run') {
        cronRunParams.push(params as Record<string, unknown>);
        return { ok: true, enqueued: true, runId: 'run-dingtalk' };
      }
      throw new Error(`unexpected rpc ${method}`);
    });

    const result = await triggerCronJobStreaming({
      getStatus: () => ({ state: 'running', warmupStatus: 'idle' }),
      rpc,
    }, 'job-dingtalk');

    expect(result.runId).toBe('run-dingtalk');
    expect(result.sessionKey).toBe('');
    expect(rpc).not.toHaveBeenCalledWith('chat.send', expect.anything(), expect.anything());
    expect(rpc).not.toHaveBeenCalledWith('agent', expect.anything(), expect.anything());
    expect(cronRunParams).toHaveLength(1);
    expect(cronRunParams[0]).toEqual({
      jobId: 'job-dingtalk',
      mode: 'force',
    });

    expect(existsSync(join(testOpenClawConfigDir, 'agents', 'main', 'sessions', 'sessions.json'))).toBe(false);
  });

  it('keeps local delivery-none runs on chat.send', async () => {
    const { triggerCronJobStreaming } = await import('../../electron/gateway/cron-supervisor');
    const chatSendParams: Record<string, unknown>[] = [];
    const rpc = vi.fn(async (method: string, params: unknown) => {
      if (method === 'cron.list') {
        return {
          jobs: [{
            id: 'job-local',
            agentId: 'main',
            name: 'Local task',
            payload: { kind: 'agentTurn', message: 'Run locally' },
            delivery: { mode: 'none' },
          }],
        };
      }
      if (method === 'chat.send') {
        chatSendParams.push(params as Record<string, unknown>);
        return { runId: 'run-local' };
      }
      throw new Error(`unexpected rpc ${method}`);
    });

    const result = await triggerCronJobStreaming({
      getStatus: () => ({ state: 'running', warmupStatus: 'idle' }),
      rpc,
    }, 'job-local');

    expect(result.runId).toBe('run-local');
    expect(rpc).not.toHaveBeenCalledWith('agent', expect.anything(), expect.anything());
    expect(chatSendParams).toHaveLength(1);
    expect(chatSendParams[0]).toMatchObject({
      agentId: 'main',
      message: 'Run locally',
      deliver: false,
    });
  });
});
