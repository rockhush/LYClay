import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

const parseJsonBodyMock = vi.fn();
const sendJsonMock = vi.fn();
const cronSupervisorMocks = vi.hoisted(() => ({
  triggerCronJobStreaming: vi.fn(),
  requestCronSupervisorPass: vi.fn(),
  emitCronJobsUpdated: vi.fn(),
  setManagedCronJobEnabled: vi.fn(),
  removeManagedCronJobState: vi.fn(),
  resolveManagedCronJobEnabled: vi.fn(),
}));

vi.mock('@electron/api/route-utils', () => ({
  parseJsonBody: (...args: unknown[]) => parseJsonBodyMock(...args),
  sendJson: (...args: unknown[]) => sendJsonMock(...args),
}));

vi.mock('@electron/gateway/cron-supervisor', () => cronSupervisorMocks);

describe('handleCronRoutes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('creates cron jobs with external delivery configuration', async () => {
    parseJsonBodyMock.mockResolvedValue({
      name: 'Weather delivery',
      message: 'Summarize today',
      schedule: '0 9 * * *',
      delivery: {
        mode: 'announce',
        channel: 'feishu',
        to: 'user:ou_weather',
      },
      enabled: true,
    });

    const rpc = vi.fn().mockResolvedValue({
      id: 'job-1',
      name: 'Weather delivery',
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 2,
      schedule: { kind: 'cron', expr: '0 9 * * *' },
      payload: { kind: 'agentTurn', message: 'Summarize today' },
      delivery: { mode: 'announce', channel: 'feishu', to: 'user:ou_weather' },
      state: {},
    });

    const { handleCronRoutes } = await import('@electron/api/routes/cron');
    const handled = await handleCronRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:13210/api/cron/jobs'),
      {
        gatewayManager: { rpc },
      } as never,
    );

    expect(handled).toBe(true);
    expect(rpc).toHaveBeenCalledWith('cron.add', expect.objectContaining({
      delivery: { mode: 'announce', channel: 'feishu', to: 'user:ou_weather' },
    }));
    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({
        id: 'job-1',
        delivery: { mode: 'announce', channel: 'feishu', to: 'user:ou_weather' },
      }),
    );
  });

  it('creates in-app cron jobs disabled in Gateway but enabled in LYClaw state', async () => {
    parseJsonBodyMock.mockResolvedValue({
      name: 'In-app task',
      message: 'Stream this later',
      schedule: '*/5 * * * *',
      enabled: true,
    });

    const rpc = vi.fn().mockResolvedValue({
      id: 'job-in-app',
      name: 'In-app task',
      enabled: false,
      createdAtMs: 1,
      updatedAtMs: 2,
      schedule: { kind: 'cron', expr: '*/5 * * * *' },
      payload: { kind: 'agentTurn', message: 'Stream this later' },
      delivery: { mode: 'none' },
      state: {},
    });

    const { handleCronRoutes } = await import('@electron/api/routes/cron');
    await handleCronRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:13210/api/cron/jobs'),
      { gatewayManager: { rpc } } as never,
    );

    expect(rpc).toHaveBeenCalledWith('cron.add', expect.objectContaining({
      enabled: false,
      delivery: { mode: 'none' },
    }));
    expect(cronSupervisorMocks.setManagedCronJobEnabled).toHaveBeenCalledWith('job-in-app', true);
    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({ id: 'job-in-app', enabled: true, delivery: { mode: 'none' } }),
    );
  });

  it('updates cron jobs with transformed payload and delivery fields', async () => {
    parseJsonBodyMock.mockResolvedValue({
      message: 'Updated prompt',
      delivery: {
        mode: 'announce',
        channel: 'feishu',
        to: 'user:ou_next',
      },
    });

    const rpc = vi.fn().mockResolvedValue({
      id: 'job-2',
      name: 'Updated job',
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 3,
      schedule: { kind: 'cron', expr: '0 9 * * *' },
      payload: { kind: 'agentTurn', message: 'Updated prompt' },
      delivery: { mode: 'announce', channel: 'feishu', to: 'user:ou_next' },
      state: {},
    });

    const { handleCronRoutes } = await import('@electron/api/routes/cron');
    await handleCronRoutes(
      { method: 'PUT' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:13210/api/cron/jobs/job-2'),
      {
        gatewayManager: { rpc },
      } as never,
    );

    expect(rpc).toHaveBeenCalledWith('cron.update', {
      id: 'job-2',
      patch: {
        payload: { kind: 'agentTurn', message: 'Updated prompt' },
        sessionTarget: 'isolated',
        delivery: { mode: 'announce', channel: 'feishu', to: 'user:ou_next' },
      },
    });
    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({
        id: 'job-2',
        message: 'Updated prompt',
        delivery: { mode: 'announce', channel: 'feishu', to: 'user:ou_next' },
      }),
    );
  });

  it('passes through delivery.accountId for multi-account cron jobs', async () => {
    parseJsonBodyMock.mockResolvedValue({
      delivery: {
        mode: 'announce',
        channel: 'feishu',
        to: 'user:ou_owner',
        accountId: 'feishu-0d009958',
      },
    });

    const rpc = vi.fn().mockResolvedValue({
      id: 'job-account',
      name: 'Account job',
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 4,
      schedule: { kind: 'cron', expr: '0 9 * * *' },
      payload: { kind: 'agentTurn', message: 'Prompt' },
      delivery: { mode: 'announce', channel: 'feishu', accountId: 'feishu-0d009958', to: 'user:ou_owner' },
      state: {},
    });

    const { handleCronRoutes } = await import('@electron/api/routes/cron');
    await handleCronRoutes(
      { method: 'PUT' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:13210/api/cron/jobs/job-account'),
      {
        gatewayManager: { rpc },
      } as never,
    );

    expect(rpc).toHaveBeenCalledWith('cron.update', {
      id: 'job-account',
      patch: {
        delivery: {
          mode: 'announce',
          channel: 'feishu',
          to: 'user:ou_owner',
          accountId: 'feishu-0d009958',
        },
      },
    });
  });

  it('allows WeChat scheduled delivery', async () => {
    parseJsonBodyMock.mockResolvedValue({
      name: 'WeChat delivery',
      message: 'Send update',
      schedule: '0 10 * * *',
      delivery: {
        mode: 'announce',
        channel: 'wechat',
        to: 'wechat:wxid_target',
        accountId: 'wechat-bot',
      },
      enabled: true,
    });

    const rpc = vi.fn().mockResolvedValue({
      id: 'job-wechat',
      name: 'WeChat delivery',
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 2,
      schedule: { kind: 'cron', expr: '0 10 * * *' },
      payload: { kind: 'agentTurn', message: 'Send update' },
      delivery: { mode: 'announce', channel: 'openclaw-weixin', to: 'wechat:wxid_target', accountId: 'wechat-bot' },
      state: {},
    });

    const { handleCronRoutes } = await import('@electron/api/routes/cron');
    const handled = await handleCronRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:13210/api/cron/jobs'),
      {
        gatewayManager: { rpc },
      } as never,
    );

    expect(handled).toBe(true);
    expect(rpc).toHaveBeenCalledWith('cron.add', expect.objectContaining({
      delivery: expect.objectContaining({ mode: 'announce', to: 'wechat:wxid_target' }),
    }));
    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({
        id: 'job-wechat',
      }),
    );
  });
});
