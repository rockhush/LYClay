import { closeElectronApp, expect, getStableWindow, test } from './fixtures/electron';

test.describe('Chat new session history', () => {
  test('new chat clears the history loading overlay without waiting for gatewayReady', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await app.evaluate(async () => {
        const { ipcMain } = process.mainModule!.require('electron') as typeof import('electron');

        ipcMain.removeHandler('gateway:status');
        ipcMain.handle('gateway:status', async () => ({
          state: 'running',
          port: 18789,
          pid: 12345,
          connectedAt: Date.now(),
          gatewayReady: false,
        }));

        ipcMain.removeHandler('gateway:rpc');
        ipcMain.handle('gateway:rpc', async (_event: unknown, method: string) => {
          if (method === 'sessions.list') {
            return {
              success: true,
              result: { sessions: [{ key: 'agent:main:main', displayName: 'main' }] },
            };
          }
          if (method === 'chat.history') {
            return { success: true, result: { messages: [] } };
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
                  connectedAt: Date.now(),
                  gatewayReady: false,
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
                json: { success: true, messages: [] },
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
      try {
        await page.reload();
      } catch (error) {
        if (!String(error).includes('ERR_FILE_NOT_FOUND')) {
          throw error;
        }
      }

      await expect(page.getByTestId('main-layout')).toBeVisible();
      await expect(page.getByTestId('chat-welcome')).toBeVisible({ timeout: 30_000 });

      await page.getByTestId('sidebar-new-chat').click();

      await expect(page.getByTestId('chat-history-loading-overlay')).toHaveCount(0, { timeout: 20_000 });
      await expect(page.getByTestId('chat-welcome')).toBeVisible();
    } finally {
      await closeElectronApp(app);
    }
  });
});
