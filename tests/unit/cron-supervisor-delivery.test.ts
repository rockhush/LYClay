import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const testOpenClawConfigDir = join(tmpdir(), 'lyclaw-tests', 'cron-supervisor-delivery');

vi.mock('../../electron/utils/paths', () => ({
  getOpenClawConfigDir: () => testOpenClawConfigDir,
}));

describe('cron supervisor delivery', () => {
  beforeEach(async () => {
    rmSync(testOpenClawConfigDir, { recursive: true, force: true });
    mkdirSync(testOpenClawConfigDir, { recursive: true });
    const { clearExternalCronDeliveryState } = await import('../../electron/gateway/cron-external-delivery');
    clearExternalCronDeliveryState();
  });

  it('uses chat.send without persisting delivery context for external-channel manual triggers', async () => {
    const { triggerCronJobStreaming } = await import('../../electron/gateway/cron-supervisor');
    const chatSendParams: Record<string, unknown>[] = [];
    const sessionsPath = join(testOpenClawConfigDir, 'agents', 'main', 'sessions', 'sessions.json');
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
      if (method === 'chat.send') {
        expect(existsSync(sessionsPath)).toBe(false);
        chatSendParams.push(params as Record<string, unknown>);
        return { runId: 'run-dingtalk' };
      }
      throw new Error(`unexpected rpc ${method}`);
    });

    const result = await triggerCronJobStreaming({
      getStatus: () => ({ state: 'running', warmupStatus: 'idle' }),
      rpc,
    }, 'job-dingtalk');

    expect(result.runId).toBe('run-dingtalk');
    expect(result.sessionKey).toMatch(/^agent:main:scheduled-task:job-dingtalk:/);
    expect(rpc).not.toHaveBeenCalledWith('cron.run', expect.anything(), expect.anything());
    expect(chatSendParams).toHaveLength(1);
    expect(chatSendParams[0]).toMatchObject({
      agentId: 'main',
      message: 'Summarize today',
      deliver: false,
      extraSystemPrompt: expect.stringContaining('Do NOT use the `message` tool'),
    });
    expect(chatSendParams[0].extraSystemPrompt).not.toContain('target="cidDailyReport="');

    const { getExternalCronDeliveryPending } = await import('../../electron/gateway/cron-external-delivery');
    expect(getExternalCronDeliveryPending('run-dingtalk')).toMatchObject({
      jobId: 'job-dingtalk',
      deliveryContext: {
        channel: 'dingtalk',
        to: 'cidDailyReport=',
        accountId: 'dingtalk-main',
      },
    });
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
    expect(chatSendParams[0]).not.toHaveProperty('extraSystemPrompt');

    const { getExternalCronDeliveryPending } = await import('../../electron/gateway/cron-external-delivery');
    expect(getExternalCronDeliveryPending('run-local')).toBeUndefined();
  });
});
