import { closeElectronApp, expect, getStableWindow, test } from './fixtures/electron';
import { openSidebarMoreNav } from './helpers/sidebar-more-nav';

const CRON_JOBS = [
  {
    id: 'job-alpha',
    name: 'Alpha Task',
    message: 'alpha',
    schedule: '0 9 * * *',
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    agentId: 'main',
  },
  {
    id: 'job-beta',
    name: 'Beta Task',
    message: 'beta',
    schedule: '0 10 * * *',
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    agentId: 'main',
  },
  {
    id: 'job-gamma',
    name: 'Gamma Task',
    message: 'gamma',
    schedule: '0 11 * * *',
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    agentId: 'main',
  },
];

test.describe('Cron job custom sort', () => {
  test('opens sort dialog and persists reordered cards', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await app.evaluate(async (jobs) => {
        const { ipcMain } = process.mainModule!.require('electron') as typeof import('electron');

        ipcMain.removeHandler('gateway:status');
        ipcMain.handle('gateway:status', async () => ({
          state: 'running',
          port: 18789,
          pid: 12345,
          connectedAt: Date.now(),
          gatewayReady: true,
        }));

        ipcMain.removeHandler('hostapi:fetch');
        ipcMain.handle('hostapi:fetch', async (_event: unknown, request: { path?: string; method?: string; body?: string }) => {
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

          if (path === '/api/cron/jobs' && method === 'GET') {
            return {
              ok: true,
              data: {
                status: 200,
                ok: true,
                json: jobs,
              },
            };
          }

          if (path === '/api/cron/supervisor-nudge' && method === 'POST') {
            return {
              ok: true,
              data: { status: 200, ok: true, json: { success: true } },
            };
          }

          if (path === '/api/channels/accounts?mode=config' && method === 'GET') {
            return {
              ok: true,
              data: {
                status: 200,
                ok: true,
                json: { success: true, channels: [] },
              },
            };
          }

          if (path === '/api/ui-state' && method === 'GET') {
            return {
              ok: true,
              data: {
                status: 200,
                ok: true,
                json: {
                  success: true,
                  state: {
                    version: 1,
                    updatedAt: Date.now(),
                    cron: { jobOrder: [] },
                  },
                },
              },
            };
          }

          if (path === '/api/ui-state' && method === 'PUT') {
            const body = JSON.parse(request.body ?? '{}') as { cron?: { jobOrder?: string[] } };
            (globalThis as { __cronSavedOrder?: string[] }).__cronSavedOrder = body.cron?.jobOrder ?? [];
            return {
              ok: true,
              data: {
                status: 200,
                ok: true,
                json: { success: true },
              },
            };
          }

          return {
            ok: true,
            data: { status: 200, ok: true, json: { success: true } },
          };
        });
      }, CRON_JOBS);

      const page = await getStableWindow(app);
      await openSidebarMoreNav(page);
      await page.getByTestId('sidebar-nav-cron').click();

      const grid = page.getByTestId('cron-job-grid');
      await expect(grid).toBeVisible();
      await expect(grid.locator('[data-testid^="cron-job-card-"]').nth(0)).toContainText('Alpha Task');

      await page.getByTestId('cron-sort-button').click();
      await expect(page.getByTestId('cron-job-sort-dialog')).toBeVisible();

      const gammaItem = page.getByTestId('cron-job-sort-item-job-gamma');
      const alphaItem = page.getByTestId('cron-job-sort-item-job-alpha');
      await gammaItem.dragTo(alphaItem);
      await page.getByTestId('cron-job-sort-confirm').click();
      await expect(page.getByTestId('cron-job-sort-dialog')).toHaveCount(0);

      await expect(grid.locator('[data-testid^="cron-job-card-"]').nth(0)).toContainText('Gamma Task');

      const savedOrder = await app.evaluate(() => (globalThis as { __cronSavedOrder?: string[] }).__cronSavedOrder ?? []);
      expect(savedOrder[0]).toBe('job-gamma');
    } finally {
      await closeElectronApp(app);
    }
  });
});
