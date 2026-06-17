import { closeElectronApp, expect, getStableWindow, test } from './fixtures/electron';

test.describe('Sidebar batch delete sessions', () => {
  test('opens grouped batch delete dialog and confirms deletion', async ({ launchElectronApp }) => {
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
          gatewayReady: true,
        }));

        ipcMain.removeHandler('gateway:rpc');
        ipcMain.handle('gateway:rpc', async (_event: unknown, method: string, params?: { key?: string }) => {
          if (method === 'sessions.list') {
            return {
              success: true,
              result: {
                sessions: [
                  {
                    key: 'agent:main:history-a',
                    displayName: 'History A',
                    updatedAt: Date.now(),
                    lastMessageAt: Date.now(),
                  },
                  {
                    key: 'agent:main:history-b',
                    displayName: 'History B',
                    updatedAt: Date.now() - 2 * 24 * 60 * 60 * 1000,
                    lastMessageAt: Date.now() - 2 * 24 * 60 * 60 * 1000,
                  },
                ],
              },
            };
          }
          if (method === 'sessions.delete' && params?.key === 'agent:main:history-a') {
            return { success: true, result: {} };
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
                  connectedAt: Date.now(),
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
      await page.goto('http://127.0.0.1:5173/');
      await page.getByTestId('sidebar').waitFor({ state: 'visible' });

      const batchDeleteButton = page.getByTestId('sidebar-batch-delete-sessions');
      await expect(batchDeleteButton).toBeVisible({ timeout: 15_000 });
      await batchDeleteButton.click();

      const dialog = page.getByTestId('batch-delete-sessions-dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.locator('.max-w-\\[500px\\]')).toBeVisible();

      await page.getByTestId('batch-delete-session-agent:main:history-a').click();
      await page.getByTestId('batch-delete-sessions-delete').click();

      const confirm = page.getByTestId('batch-delete-sessions-confirm');
      await expect(confirm).toBeVisible();
      await expect(confirm).toContainText('确认要删除选中的会话吗？');
      await confirm.getByRole('button', { name: '删除' }).click();

      await expect(dialog).toBeHidden({ timeout: 10_000 });
      await expect(page.getByTestId('batch-delete-session-agent:main:history-a')).toHaveCount(0);
    } finally {
      await closeElectronApp(app);
    }
  });
});
