import { closeElectronApp, expect, getStableWindow, test } from './fixtures/electron';

const MOCK_GATEWAY_SKILLS = [
  {
    skillKey: 'skill-alpha',
    slug: 'skill-alpha',
    name: 'Alpha Skill',
    description: 'alpha',
    disabled: false,
    baseDir: '/tmp/skills/skill-alpha',
    filePath: '/tmp/skills/skill-alpha/SKILL.md',
  },
  {
    skillKey: 'skill-beta',
    slug: 'skill-beta',
    name: 'Beta Skill',
    description: 'beta',
    disabled: false,
    baseDir: '/tmp/skills/skill-beta',
    filePath: '/tmp/skills/skill-beta/SKILL.md',
  },
  {
    skillKey: 'skill-gamma',
    slug: 'skill-gamma',
    name: 'Gamma Skill',
    description: 'gamma',
    disabled: false,
    baseDir: '/tmp/skills/skill-gamma',
    filePath: '/tmp/skills/skill-gamma/SKILL.md',
  },
];

test.describe('Skills custom sort', () => {
  test('opens sort dialog from actions menu and persists reordered cards', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await app.evaluate(async (gatewaySkills) => {
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
        ipcMain.handle('gateway:rpc', async (_event: unknown, method: string) => {
          if (method === 'skills.status') {
            return {
              success: true,
              result: { skills: gatewaySkills },
            };
          }
          return { success: true, result: {} };
        });

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
                    skills: { mySkillOrder: [] },
                  },
                },
              },
            };
          }

          if (path === '/api/ui-state' && method === 'PUT') {
            const body = JSON.parse(request.body ?? '{}') as { skills?: { mySkillOrder?: string[] } };
            (globalThis as { __skillsSavedOrder?: string[] }).__skillsSavedOrder = body.skills?.mySkillOrder ?? [];
            return {
              ok: true,
              data: {
                status: 200,
                ok: true,
                json: { success: true },
              },
            };
          }

          if (path === '/api/clawhub/list' && method === 'GET') {
            return {
              ok: true,
              data: {
                status: 200,
                ok: true,
                json: { success: true, results: [] },
              },
            };
          }

          if (path === '/api/clawhub/search' && method === 'POST') {
            return {
              ok: true,
              data: {
                status: 200,
                ok: true,
                json: { success: true, results: [] },
              },
            };
          }

          if (path === '/api/clawhub/company-install-map' && method === 'GET') {
            return {
              ok: true,
              data: {
                status: 200,
                ok: true,
                json: { success: true, installs: {}, entries: {}, byPackageSlug: {} },
              },
            };
          }

          if (path === '/api/skills/configs' && method === 'GET') {
            return {
              ok: true,
              data: {
                status: 200,
                ok: true,
                json: {},
              },
            };
          }

          if (path === '/api/skills/bundled' && method === 'GET') {
            return {
              ok: true,
              data: {
                status: 200,
                ok: true,
                json: { success: true, skills: [] },
              },
            };
          }

          return {
            ok: true,
            data: { status: 200, ok: true, json: { success: true } },
          };
        });
      }, MOCK_GATEWAY_SKILLS);

      const page = await getStableWindow(app);
      await page.getByTestId('sidebar-nav-skills').click();

      await expect(page.getByRole('heading', { name: 'Alpha Skill' })).toBeVisible();

      await page.getByTestId('skills-actions-button').click();
      await page.getByTestId('skills-sort-action').click();
      await expect(page.getByTestId('skills-sort-dialog')).toBeVisible();

      const gammaItem = page.getByTestId('skills-sort-item-skill-gamma');
      const alphaItem = page.getByTestId('skills-sort-item-skill-alpha');
      await gammaItem.dragTo(alphaItem);
      await page.getByTestId('skills-sort-confirm').click();
      await expect(page.getByTestId('skills-sort-dialog')).toHaveCount(0);

      const headings = page.locator('h3');
      await expect(headings.nth(0)).toContainText('Gamma Skill');

      const savedOrder = await app.evaluate(() => (globalThis as { __skillsSavedOrder?: string[] }).__skillsSavedOrder ?? []);
      expect(savedOrder[0]).toBe('skill-gamma');
    } finally {
      await closeElectronApp(app);
    }
  });
});
