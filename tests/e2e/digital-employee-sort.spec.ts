import { closeElectronApp, expect, getStableWindow, test } from './fixtures/electron';

const MOCK_EMPLOYEES = [
  {
    instanceId: 'employee-alpha--111',
    marketEmployeeId: 'alpha',
    packageId: 'com.lyclaw.employee.alpha',
    packageVersion: '1.0.0',
    name: 'Alpha Employee',
    description: 'alpha',
    tags: [],
    installPath: '/tmp/alpha',
    agentId: 'employee-alpha-111',
    sessionKey: 'agent:employee-alpha-111:main',
    status: 'active',
    enabled: true,
    warnings: [],
  },
  {
    instanceId: 'employee-beta--222',
    marketEmployeeId: 'beta',
    packageId: 'com.lyclaw.employee.beta',
    packageVersion: '1.0.0',
    name: 'Beta Employee',
    description: 'beta',
    tags: [],
    installPath: '/tmp/beta',
    agentId: 'employee-beta-222',
    sessionKey: 'agent:employee-beta-222:main',
    status: 'active',
    enabled: true,
    warnings: [],
  },
  {
    instanceId: 'employee-gamma--333',
    marketEmployeeId: 'gamma',
    packageId: 'com.lyclaw.employee.gamma',
    packageVersion: '1.0.0',
    name: 'Gamma Employee',
    description: 'gamma',
    tags: [],
    installPath: '/tmp/gamma',
    agentId: 'employee-gamma-333',
    sessionKey: 'agent:employee-gamma-333:main',
    status: 'active',
    enabled: true,
    warnings: [],
  },
];

const MOCK_MARKETPLACE = [
  {
    slug: 'alpha',
    name: 'Alpha Employee',
    description: 'alpha',
    version: '1.0.0',
    author: 'Test',
    downloads: 1,
    updateTime: '2026-01-01 00:00:00',
    category: 'office',
    installed: true,
    tags: [],
  },
  {
    slug: 'beta',
    name: 'Beta Employee',
    description: 'beta',
    version: '1.0.0',
    author: 'Test',
    downloads: 1,
    updateTime: '2026-01-01 00:00:00',
    category: 'office',
    installed: true,
    tags: [],
  },
  {
    slug: 'gamma',
    name: 'Gamma Employee',
    description: 'gamma',
    version: '1.0.0',
    author: 'Test',
    downloads: 1,
    updateTime: '2026-01-01 00:00:00',
    category: 'office',
    installed: true,
    tags: [],
  },
];

test.describe('Digital employee custom sort', () => {
  test('opens sort dialog and persists reordered cards', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await app.evaluate(async ({ employees, marketplace }) => {
        const { ipcMain } = process.mainModule!.require('electron') as typeof import('electron');

        ipcMain.removeHandler('hostapi:fetch');
        ipcMain.handle('hostapi:fetch', async (_event: unknown, request: { path?: string; method?: string; body?: string }) => {
          const path = request?.path ?? '';
          const method = request?.method ?? 'GET';

          if (path === '/api/digital-employees' && method === 'GET') {
            return {
              ok: true,
              data: { status: 200, ok: true, json: employees },
            };
          }

          if (path === '/api/digital-employee/marketplace/list' && method === 'POST') {
            return {
              ok: true,
              data: {
                status: 200,
                ok: true,
                json: { success: true, results: marketplace },
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
                    digitalEmployees: { myEmployeeOrder: [] },
                  },
                },
              },
            };
          }

          if (path === '/api/ui-state' && method === 'PUT') {
            const body = JSON.parse(request.body ?? '{}') as { digitalEmployees?: { myEmployeeOrder?: string[] } };
            (globalThis as { __digitalEmployeeSavedOrder?: string[] }).__digitalEmployeeSavedOrder = body.digitalEmployees?.myEmployeeOrder ?? [];
            return {
              ok: true,
              data: { status: 200, ok: true, json: { success: true } },
            };
          }

          return {
            ok: true,
            data: { status: 200, ok: true, json: { success: true } },
          };
        });
      }, { employees: MOCK_EMPLOYEES, marketplace: MOCK_MARKETPLACE });

      const page = await getStableWindow(app);
      await page.getByTestId('sidebar-nav-digital-employee').click();
      await expect(page.getByText('Alpha Employee')).toBeVisible();

      await page.getByTestId('digital-employee-sort-button').click();
      await expect(page.getByTestId('digital-employee-sort-dialog')).toBeVisible();

      await page.getByTestId('digital-employee-sort-item-employee-gamma--333').dragTo(
        page.getByTestId('digital-employee-sort-item-employee-alpha--111'),
      );
      await page.getByTestId('digital-employee-sort-confirm').click();
      await expect(page.getByTestId('digital-employee-sort-dialog')).toHaveCount(0);

      await expect(page.getByTestId('digital-employee-my-use-employee-gamma--333')).toBeVisible();

      const savedOrder = await app.evaluate(() => (globalThis as { __digitalEmployeeSavedOrder?: string[] }).__digitalEmployeeSavedOrder ?? []);
      expect(savedOrder[0]).toBe('employee-gamma--333');
    } finally {
      await closeElectronApp(app);
    }
  });
});
