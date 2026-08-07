import {
  closeElectronApp,
  expect,
  getStableWindow,
  installIpcMocks,
  test,
} from './fixtures/electron';
import { openSidebarMoreNav } from './helpers/sidebar-more-nav';

const MAIN_SESSION_KEY = 'agent:main:main';
const GATEWAY_STATUS = {
  state: 'running',
  port: 18789,
  pid: 12345,
  gatewayReady: true,
  warmupStatus: 'ready',
};

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);
  return `{${entries.join(',')}}`;
}

const BASE_HOST_API = {
  '["/api/gateway/status","GET"]': {
    ok: true,
    data: { status: 200, ok: true, json: GATEWAY_STATUS },
  },
  '["/api/agents","GET"]': {
    ok: true,
    data: {
      status: 200,
      ok: true,
      json: { success: true, agents: [{ id: 'main', name: 'main' }] },
    },
  },
};

async function reloadAfterInstallingMocks(page: Awaited<ReturnType<typeof getStableWindow>>): Promise<void> {
  try {
    await page.reload();
  } catch (error) {
    if (!String(error).includes('ERR_FILE_NOT_FOUND') && !String(error).includes('Timeout')) {
      throw error;
    }
  }
}

test.describe('recoverable operational error guidance', () => {
  test('shows friendly chat guidance without exposing an unknown local path', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    const rawError = 'ENOENT: no such file or directory, open C:\\Users\\private-user\\.openclaw\\state.json';
    const history = [{ role: 'user', content: 'Read the local state', timestamp: Date.now() }];

    try {
      await installIpcMocks(app, {
        gatewayStatus: GATEWAY_STATUS,
        gatewayRpc: {
          [stableStringify(['sessions.list', {}])]: {
            success: true,
            result: { sessions: [{ key: MAIN_SESSION_KEY, displayName: 'main' }] },
          },
          [stableStringify(['chat.history', { sessionKey: MAIN_SESSION_KEY, limit: 200 }])]: {
            success: true,
            result: { messages: history },
          },
          [stableStringify(['chat.history', { sessionKey: MAIN_SESSION_KEY, limit: 1000 }])]: {
            success: true,
            result: { messages: history },
          },
          [stableStringify(['chat.send', null])]: { success: false, error: rawError },
        },
        hostApi: BASE_HOST_API,
      });

      const page = await getStableWindow(app);
      await reloadAfterInstallingMocks(page);
      await expect(page.getByText('Read the local state', { exact: true })).toBeVisible();
      await page.getByTestId('chat-composer-input').fill('Retry the local read');
      await page.getByTestId('chat-composer-send').click();

      const callout = page.getByTestId('chat-error');
      await expect(callout).toBeVisible({ timeout: 30_000 });
      await expect(callout).toContainText('本地路径已隐藏');
      await expect(page.getByText(/private-user/)).toHaveCount(0);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('explains a provider payload rejection without exposing the raw schema error', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    const rawError = 'LLM request failed: provider rejected the request schema or tool payload.';
    const history = [{ role: 'user', content: 'Use the available tools', timestamp: Date.now() }];

    try {
      await installIpcMocks(app, {
        gatewayStatus: GATEWAY_STATUS,
        gatewayRpc: {
          [stableStringify(['sessions.list', {}])]: {
            success: true,
            result: { sessions: [{ key: MAIN_SESSION_KEY, displayName: 'main' }] },
          },
          [stableStringify(['chat.history', { sessionKey: MAIN_SESSION_KEY, limit: 200 }])]: {
            success: true,
            result: { messages: history },
          },
          [stableStringify(['chat.history', { sessionKey: MAIN_SESSION_KEY, limit: 1000 }])]: {
            success: true,
            result: { messages: history },
          },
          [stableStringify(['chat.send', null])]: { success: false, error: rawError },
        },
        hostApi: BASE_HOST_API,
      });

      const page = await getStableWindow(app);
      await reloadAfterInstallingMocks(page);
      await page.getByTestId('chat-composer-input').fill('Retry with tools');
      await page.getByTestId('chat-composer-send').click();

      const callout = page.getByTestId('chat-error');
      await expect(callout).toContainText('模型服务拒绝了当前请求或工具参数格式', { timeout: 30_000 });
      await expect(callout).toContainText('切换模型');
      await expect(callout).not.toContainText('schema or tool payload');
    } finally {
      await closeElectronApp(app);
    }
  });

  test('localizes an embedded agent no-response notice and preserves retry caution', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    const rawNotice = "Agent couldn't generate a response. Note: some tool actions may have already been executed — please verify before retrying.";
    const history = [
      { role: 'user', content: 'Run the tools', timestamp: Date.now() - 1000 },
      { role: 'assistant', content: rawNotice, stopReason: 'stop', timestamp: Date.now() },
    ];

    try {
      await installIpcMocks(app, {
        gatewayStatus: GATEWAY_STATUS,
        gatewayRpc: {
          [stableStringify(['sessions.list', {}])]: {
            success: true,
            result: { sessions: [{ key: MAIN_SESSION_KEY, displayName: 'main' }] },
          },
          [stableStringify(['chat.history', { sessionKey: MAIN_SESSION_KEY, limit: 200 }])]: {
            success: true,
            result: { messages: history },
          },
          [stableStringify(['chat.history', { sessionKey: MAIN_SESSION_KEY, limit: 1000 }])]: {
            success: true,
            result: { messages: history },
          },
        },
        hostApi: BASE_HOST_API,
      });

      const page = await getStableWindow(app);
      await reloadAfterInstallingMocks(page);

      await expect(page.getByText(/智能体未能生成回复/)).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(/确认实际结果/)).toBeVisible();
      await expect(page.getByText(/Agent couldn't generate a response/)).toHaveCount(0);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('hides non-blocking tool failure rows after a successful result', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    const history = [
      { role: 'user', content: 'Save the requested file', timestamp: Date.now() - 2000 },
      {
        role: 'assistant',
        content: 'Write failed',
        stopReason: 'toolUse',
        timestamp: Date.now() - 1000,
      },
      {
        role: 'assistant',
        content: 'The requested file was saved successfully.',
        stopReason: 'stop',
        timestamp: Date.now(),
      },
    ];

    try {
      await installIpcMocks(app, {
        gatewayStatus: GATEWAY_STATUS,
        gatewayRpc: {
          [stableStringify(['sessions.list', {}])]: {
            success: true,
            result: { sessions: [{ key: MAIN_SESSION_KEY, displayName: 'main' }] },
          },
          [stableStringify(['chat.history', { sessionKey: MAIN_SESSION_KEY, limit: 200 }])]: {
            success: true,
            result: { messages: history },
          },
          [stableStringify(['chat.history', { sessionKey: MAIN_SESSION_KEY, limit: 1000 }])]: {
            success: true,
            result: { messages: history },
          },
        },
        hostApi: BASE_HOST_API,
      });

      const page = await getStableWindow(app);
      await reloadAfterInstallingMocks(page);

      await expect(page.getByText('The requested file was saved successfully.')).toBeVisible({
        timeout: 30_000,
      });
      const graph = page.getByTestId('chat-execution-graph');
      if (await graph.count() > 0 && await graph.getAttribute('data-collapsed') === 'true') {
        await graph.click();
      }
      await expect(page.getByTestId('chat-execution-step').filter({ hasText: 'Write failed' })).toHaveCount(0);
      await expect(page.getByText('Write failed', { exact: true })).toHaveCount(0);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('labels only model-call cron timeouts as model response timeouts', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    const jobs = [
      {
        id: 'job-model-timeout',
        name: 'Model timeout task',
        message: 'model',
        schedule: '0 9 * * *',
        enabled: true,
        createdAt: '2026-08-05T00:00:00.000Z',
        updatedAt: '2026-08-05T00:00:00.000Z',
        agentId: 'main',
        lastRun: {
          time: '2026-08-05T00:01:00.000Z',
          success: false,
          error: 'cron: job execution timed out (last phase: model-call-started)',
        },
      },
      {
        id: 'job-delivery-timeout',
        name: 'Delivery timeout task',
        message: 'delivery',
        schedule: '0 10 * * *',
        enabled: true,
        createdAt: '2026-08-05T00:00:00.000Z',
        updatedAt: '2026-08-05T00:00:00.000Z',
        agentId: 'main',
        lastRun: {
          time: '2026-08-05T00:01:00.000Z',
          success: false,
          error: 'cron: job execution timed out (last phase: delivery-started)',
        },
      },
    ];

    try {
      await installIpcMocks(app, {
        gatewayStatus: GATEWAY_STATUS,
        hostApi: {
          ...BASE_HOST_API,
          '["/api/cron/jobs","GET"]': {
            ok: true,
            data: { status: 200, ok: true, json: jobs },
          },
          '["/api/cron/supervisor-nudge","POST"]': {
            ok: true,
            data: { status: 200, ok: true, json: { success: true } },
          },
          '["/api/channels/accounts?mode=config","GET"]': {
            ok: true,
            data: { status: 200, ok: true, json: { success: true, channels: [] } },
          },
        },
      });

      const page = await getStableWindow(app);
      await openSidebarMoreNav(page);
      await page.getByTestId('sidebar-nav-cron').click();

      await expect(page.getByTestId('cron-job-card-job-model-timeout')).toContainText('等待大模型回复超时');
      await expect(page.getByTestId('cron-job-card-job-delivery-timeout')).not.toContainText('等待大模型回复');
      await expect(page.getByTestId('cron-job-card-job-delivery-timeout')).toContainText('超时');
    } finally {
      await closeElectronApp(app);
    }
  });

  test('guides the user to release locked files after an EBUSY uninstall failure', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    const employee = {
      instanceId: 'locked-employee--123',
      marketEmployeeId: 'locked-employee',
      packageId: 'com.lyclaw.employee.locked',
      packageVersion: '1.0.0',
      name: 'Locked employee',
      description: 'test employee',
      tags: [],
      installPath: 'C:\\Users\\private-user\\.openclaw\\skill\\locked-employee',
      agentId: 'employee-locked-123',
      sessionKey: 'agent:employee-locked-123:main',
      status: 'active',
      enabled: true,
      warnings: [],
    };

    try {
      await installIpcMocks(app, {
        hostApi: {
          ...BASE_HOST_API,
          '["/api/digital-employees","GET"]': {
            ok: true,
            data: { status: 200, ok: true, json: [employee] },
          },
          '["/api/digital-employee/marketplace/list","POST"]': {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: {
                success: true,
                results: [{
                  slug: 'locked-employee',
                  name: 'Locked employee',
                  description: 'test employee',
                  version: '1.0.0',
                  author: 'LYClaw',
                  downloads: 1,
                  updateTime: '2026-08-05 10:00:00',
                  category: 'rnd',
                  installed: true,
                  tags: [],
                }],
              },
            },
          },
          '["/api/digital-employees/uninstall","POST"]': {
            ok: true,
            data: {
              status: 500,
              ok: false,
              json: {
                error: "Error: EBUSY: resource busy or locked, rmdir 'C:\\Users\\private-user\\.openclaw\\skill\\locked-employee'",
              },
            },
          },
        },
      });

      const page = await getStableWindow(app);
      await page.getByTestId('sidebar-nav-digital-employee').click();
      await expect(page.getByText('Locked employee')).toBeVisible();
      await page.getByTestId(`digital-employee-my-uninstall-${employee.instanceId}`).click();

      await expect(page.getByText(/文件正在被占用，暂时无法卸载/)).toBeVisible();
      await expect(page.getByText(/private-user/)).toHaveCount(0);
    } finally {
      await closeElectronApp(app);
    }
  });
});
