import { mkdirSync, rmSync, readFileSync } from 'node:fs';
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
    const chatSendParams: Record<string, unknown>[] = [];
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
    expect(chatSendParams).toHaveLength(1);
    expect(chatSendParams[0]).toMatchObject({
      message: 'Summarize today',
      deliver: true,
      extraSystemPrompt: expect.stringContaining('target="cidDailyReport="'),
    });

    const sessionKey = chatSendParams[0].sessionKey as string;
    const sessions = JSON.parse(readFileSync(
      join(testOpenClawConfigDir, 'agents', 'main', 'sessions', 'sessions.json'),
      'utf8',
    )) as Record<string, { deliveryContext?: Record<string, unknown> }>;
    expect(sessions[sessionKey]?.deliveryContext).toEqual({
      channel: 'dingtalk',
      accountId: 'dingtalk-main',
      to: 'cidDailyReport=',
    });
  });
});
