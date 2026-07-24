import { closeElectronApp, expect, getStableWindow, test } from './fixtures/electron';

test.describe('Sidebar history section collapse', () => {
  test('collapses and expands time buckets with correct defaults', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await app.evaluate(async () => {
        const { ipcMain } = process.mainModule!.require('electron') as typeof import('electron');
        const now = Date.now();
        const dayMs = 24 * 60 * 60 * 1000;

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
                    key: 'agent:main:today-session',
                    displayName: 'Today session',
                    updatedAt: now,
                    lastMessageAt: now,
                  },
                  {
                    key: 'agent:main:week-session',
                    displayName: 'Within week session',
                    updatedAt: now - 3 * dayMs,
                    lastMessageAt: now - 3 * dayMs,
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
      await page.reload();
      await expect(page.getByTestId('main-layout')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('sidebar')).toBeVisible();

      const todayRow = page.getByTestId('sidebar-session-agent:main:today-session');
      const weekRow = page.getByTestId('sidebar-session-agent:main:week-session');

      await expect(todayRow).toBeVisible({ timeout: 15_000 });
      await expect(weekRow).toHaveCount(0);

      await page.getByTestId('sidebar-history-section-toggle-withinWeek').click();
      await expect(weekRow).toBeVisible();

      await page.getByTestId('sidebar-history-section-toggle-today').click();
      await expect(todayRow).toHaveCount(0);

      await page.getByTestId('sidebar-history-section-toggle-today').click();
      await expect(todayRow).toBeVisible();
    } finally {
      await closeElectronApp(app);
    }
  });
});
