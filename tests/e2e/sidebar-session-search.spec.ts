import { closeElectronApp, expect, getStableWindow, test } from './fixtures/electron';

// Requires a fresh renderer build: pnpm run build:vite (or pnpm run test:e2e).
test.describe('Sidebar session search', () => {
  test('filters sessions locally and restores list on clear', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await app.evaluate(async () => {
        const { ipcMain } = process.mainModule!.require('electron') as typeof import('electron');
        const now = Date.now();

        ipcMain.removeHandler('gateway:status');
        ipcMain.handle('gateway:status', async () => ({
          state: 'running',
          port: 18789,
          pid: 12345,
          connectedAt: now,
          gatewayReady: true,
        }));

        ipcMain.removeHandler('gateway:rpc');
        ipcMain.handle('gateway:rpc', async (_event: unknown, method: string) => {
          if (method === 'sessions.list') {
            return {
              success: true,
              result: {
                sessions: [
                  {
                    key: 'agent:main:alpha-session',
                    displayName: 'Alpha football chat',
                    updatedAt: now,
                    lastMessageAt: now,
                  },
                  {
                    key: 'agent:main:beta-session',
                    displayName: 'Beta basketball chat',
                    updatedAt: now - 60 * 60 * 1000,
                    lastMessageAt: now - 60 * 60 * 1000,
                  },
                ],
              },
            };
          }
          if (method === 'chat.history') {
            return { success: true, result: { messages: [{ role: 'user', content: 'hello' }] } };
          }
          return { success: true, result: {} };
        });

        ipcMain.removeHandler('hostapi:fetch');
        ipcMain.handle('hostapi:fetch', async (_event: unknown, request: { path?: string; method?: string }) => {
          const path = request?.path ?? '';
          const method = request?.method ?? 'GET';

          if (path === '/api/gateway/status' && method === 'GET') {
            return {
              ok: true,
              data: {
                status: 200,
                ok: true,
                json: {
                  state: 'running',
                  port: 18789,
                  pid: 12345,
                  connectedAt: now,
                  gatewayReady: true,
                },
              },
            };
          }

          if (path === '/api/agents' && method === 'GET') {
            return {
              ok: true,
              data: {
                status: 200,
                ok: true,
                json: { success: true, agents: [{ id: 'main', name: 'main' }] },
              },
            };
          }

          if (path.startsWith('/api/sessions/history-local')) {
            return {
              ok: true,
              data: {
                status: 200,
                ok: true,
                json: { success: true, messages: [{ role: 'user', content: 'hello' }] },
              },
            };
          }

          return {
            ok: true,
            data: { status: 200, ok: true, json: {} },
          };
        });
      });

      const page = await getStableWindow(app);
      await page.evaluate(() => {
        window.localStorage.setItem(
          'LYClaw-settings',
          JSON.stringify({
            state: {
              sidebarCollapsed: false,
              setupComplete: true,
            },
            version: 0,
          }),
        );
      });
      await page.reload();
      await expect(page.getByTestId('main-layout')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('sidebar-session-search')).toBeVisible({ timeout: 15_000 });

      const alphaRow = page.getByTestId('sidebar-session-agent:main:alpha-session');
      const betaRow = page.getByTestId('sidebar-session-agent:main:beta-session');

      await expect(alphaRow).toBeVisible({ timeout: 15_000 });
      await expect(betaRow).toBeVisible();

      await page.getByTestId('sidebar-session-search').fill('football');
      await expect(alphaRow).toBeVisible();
      await expect(betaRow).toHaveCount(0);

      await page.getByTestId('sidebar-session-search-clear').click();
      await expect(alphaRow).toBeVisible();
      await expect(betaRow).toBeVisible();
    } finally {
      await closeElectronApp(app);
    }
  });

  test('filters sessions by agent display name', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await app.evaluate(async () => {
        const { ipcMain } = process.mainModule!.require('electron') as typeof import('electron');
        const now = Date.now();
        const dqeAgentId = 'employee-dqe-test';

        ipcMain.removeHandler('gateway:status');
        ipcMain.handle('gateway:status', async () => ({
          state: 'running',
          port: 18789,
          pid: 12345,
          connectedAt: now,
          gatewayReady: true,
        }));

        ipcMain.removeHandler('gateway:rpc');
        ipcMain.handle('gateway:rpc', async (_event: unknown, method: string) => {
          if (method === 'sessions.list') {
            return {
              success: true,
              result: {
                sessions: [
                  {
                    key: `agent:${dqeAgentId}:dqe-alpha`,
                    displayName: '帮我生成报告',
                    updatedAt: now,
                    lastMessageAt: now,
                  },
                  {
                    key: `agent:${dqeAgentId}:dqe-beta`,
                    displayName: '网球历史第一人',
                    updatedAt: now - 60 * 60 * 1000,
                    lastMessageAt: now - 60 * 60 * 1000,
                  },
                  {
                    key: 'agent:main:other-session',
                    displayName: 'Other topic chat',
                    updatedAt: now - 2 * 60 * 60 * 1000,
                    lastMessageAt: now - 2 * 60 * 60 * 1000,
                  },
                ],
              },
            };
          }
          if (method === 'chat.history') {
            return { success: true, result: { messages: [{ role: 'user', content: 'hello' }] } };
          }
          return { success: true, result: {} };
        });

        ipcMain.removeHandler('hostapi:fetch');
        ipcMain.handle('hostapi:fetch', async (_event: unknown, request: { path?: string; method?: string }) => {
          const path = request?.path ?? '';
          const method = request?.method ?? 'GET';

          if (path === '/api/gateway/status' && method === 'GET') {
            return {
              ok: true,
              data: {
                status: 200,
                ok: true,
                json: {
                  state: 'running',
                  port: 18789,
                  pid: 12345,
                  connectedAt: now,
                  gatewayReady: true,
                },
              },
            };
          }

          if (path === '/api/agents' && method === 'GET') {
            return {
              ok: true,
              data: {
                status: 200,
                ok: true,
                json: {
                  success: true,
                  agents: [
                    { id: 'main', name: 'main' },
                    { id: dqeAgentId, name: 'DQE质量流程数字员工' },
                  ],
                },
              },
            };
          }

          if (path.startsWith('/api/sessions/history-local')) {
            return {
              ok: true,
              data: {
                status: 200,
                ok: true,
                json: { success: true, messages: [{ role: 'user', content: 'hello' }] },
              },
            };
          }

          return {
            ok: true,
            data: { status: 200, ok: true, json: {} },
          };
        });
      });

      const page = await getStableWindow(app);
      await page.evaluate(() => {
        window.localStorage.setItem(
          'LYClaw-settings',
          JSON.stringify({
            state: {
              sidebarCollapsed: false,
              setupComplete: true,
            },
            version: 0,
          }),
        );
      });
      await page.reload();
      await expect(page.getByTestId('main-layout')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('sidebar-session-search')).toBeVisible({ timeout: 15_000 });

      const dqeAlphaRow = page.getByTestId('sidebar-session-agent:employee-dqe-test:dqe-alpha');
      const dqeBetaRow = page.getByTestId('sidebar-session-agent:employee-dqe-test:dqe-beta');
      const otherRow = page.getByTestId('sidebar-session-agent:main:other-session');

      await expect(dqeAlphaRow).toBeVisible({ timeout: 15_000 });
      await expect(dqeBetaRow).toBeVisible();
      await expect(otherRow).toBeVisible();

      await page.getByTestId('sidebar-session-search').fill('DQE');
      await expect(dqeAlphaRow).toBeVisible();
      await expect(dqeBetaRow).toBeVisible();
      await expect(otherRow).toHaveCount(0);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('filters sessions by category (all, cron, session)', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await app.evaluate(async () => {
        const { ipcMain } = process.mainModule!.require('electron') as typeof import('electron');
        const now = Date.now();

        ipcMain.removeHandler('gateway:status');
        ipcMain.handle('gateway:status', async () => ({
          state: 'running',
          port: 18789,
          pid: 12345,
          connectedAt: now,
          gatewayReady: true,
        }));

        ipcMain.removeHandler('gateway:rpc');
        ipcMain.handle('gateway:rpc', async (_event: unknown, method: string) => {
          if (method === 'sessions.list') {
            return {
              success: true,
              result: {
                sessions: [
                  {
                    key: 'agent:main:session-1001',
                    displayName: 'Normal chat session',
                    updatedAt: now,
                    lastMessageAt: now,
                  },
                  {
                    key: 'agent:main:scheduled-task:job-a:run-1',
                    displayName: 'Scheduled task run',
                    updatedAt: now - 60 * 60 * 1000,
                    lastMessageAt: now - 60 * 60 * 1000,
                  },
                ],
              },
            };
          }
          if (method === 'chat.history') {
            return { success: true, result: { messages: [{ role: 'user', content: 'hello' }] } };
          }
          return { success: true, result: {} };
        });

        ipcMain.removeHandler('hostapi:fetch');
        ipcMain.handle('hostapi:fetch', async (_event: unknown, request: { path?: string; method?: string }) => {
          const path = request?.path ?? '';
          const method = request?.method ?? 'GET';

          if (path === '/api/gateway/status' && method === 'GET') {
            return {
              ok: true,
              data: {
                status: 200,
                ok: true,
                json: {
                  state: 'running',
                  port: 18789,
                  pid: 12345,
                  connectedAt: now,
                  gatewayReady: true,
                },
              },
            };
          }

          if (path === '/api/agents' && method === 'GET') {
            return {
              ok: true,
              data: {
                status: 200,
                ok: true,
                json: { success: true, agents: [{ id: 'main', name: 'main' }] },
              },
            };
          }

          if (path.startsWith('/api/sessions/history-local')) {
            return {
              ok: true,
              data: {
                status: 200,
                ok: true,
                json: { success: true, messages: [{ role: 'user', content: 'hello' }] },
              },
            };
          }

          return {
            ok: true,
            data: { status: 200, ok: true, json: {} },
          };
        });
      });

      const page = await getStableWindow(app);
      await page.evaluate(() => {
        window.localStorage.setItem(
          'LYClaw-settings',
          JSON.stringify({
            state: {
              sidebarCollapsed: false,
              setupComplete: true,
            },
            version: 0,
          }),
        );
      });
      await page.reload();
      await expect(page.getByTestId('main-layout')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('sidebar-session-filter-trigger')).toBeVisible({ timeout: 15_000 });

      const normalRow = page.getByTestId('sidebar-session-agent:main:session-1001');
      const cronRow = page.getByTestId('sidebar-session-agent:main:scheduled-task:job-a:run-1');

      await expect(normalRow).toBeVisible({ timeout: 15_000 });
      await expect(cronRow).toBeVisible();

      await page.getByTestId('sidebar-session-filter-trigger').click();
      await expect(page.getByTestId('sidebar-session-filter-panel')).toBeVisible();
      await page.getByTestId('sidebar-session-filter-option-session').click();
      await expect(page.getByTestId('sidebar-session-filter-panel')).toHaveCount(0);
      await expect(normalRow).toBeVisible();
      await expect(cronRow).toHaveCount(0);

      await page.getByTestId('sidebar-session-filter-trigger').click();
      await page.getByTestId('sidebar-session-filter-option-cron').click();
      await expect(page.getByTestId('sidebar-session-filter-panel')).toHaveCount(0);
      await expect(cronRow).toBeVisible();
      await expect(normalRow).toHaveCount(0);

      await page.getByTestId('sidebar-session-filter-trigger').click();
      await page.getByTestId('sidebar-session-filter-reset').click();
      await expect(page.getByTestId('sidebar-session-filter-panel')).toHaveCount(0);
      await expect(normalRow).toBeVisible();
      await expect(cronRow).toBeVisible();
    } finally {
      await closeElectronApp(app);
    }
  });
});
