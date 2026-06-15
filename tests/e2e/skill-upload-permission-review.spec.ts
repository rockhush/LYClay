import { closeElectronApp, expect, getStableWindow, test } from './fixtures/electron';

test.describe('Skill upload permission review', () => {
  test('installs a Workspace-base-only Skill without an extra permission review', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      await app.evaluate(async ({ app: _app }) => {
        const { ipcMain } = process.mainModule!.require('electron') as typeof import('electron');
        ipcMain.removeHandler('skill:uploadZip');
        ipcMain.handle('skill:uploadZip', async () => ({
          success: true,
          skillName: 'basic-skill',
          validationResult: {
            riskLevel: 'low',
            findings: [],
            summary: { errors: 0, warnings: 0 },
            stage: 'complete',
          },
        }));
      });

      const page = await getStableWindow(app);
      await expect(page.getByTestId('main-layout')).toBeVisible();
      await page.getByTestId('sidebar-nav-skills').click();
      await page.getByTestId('skills-actions-button').click();
      await page.getByTestId('skills-upload-action').click();
      await page.locator('#skill-upload-input').setInputFiles({
        name: 'basic-skill.zip',
        mimeType: 'application/zip',
        buffer: Buffer.from('zip-content'),
      });
      await page.getByTestId('skill-upload-submit-button').click();

      await expect(page.getByTestId('skill-permission-review')).toHaveCount(0);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('keeps installation behind a permission confirmation step', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      await app.evaluate(async ({ app: _app }) => {
        const { ipcMain } = process.mainModule!.require('electron') as typeof import('electron');
        ipcMain.removeHandler('skill:uploadZip');
        ipcMain.handle('skill:uploadZip', async (_event: unknown, params: { autoInstall?: boolean; confirmationToken?: string }) => {
          if (!params.autoInstall) {
            return {
              success: true,
              preview: true,
              skillName: 'safe-skill',
              confirmationToken: 'e2e-preview-token',
              permissions: {
                filesystem: ['workspace:metadata', 'workspace:read', 'workspace:write'],
                network: ['api.example.com'],
                commands: [],
                secrets: [],
              },
              permissionDiff: {
                added: ['network:api.example.com'],
                unchanged: [
                  'filesystem:workspace:metadata',
                  'filesystem:workspace:read',
                  'filesystem:workspace:write',
                ],
                removed: [],
              },
              validationResult: {
                riskLevel: 'medium',
                findings: [],
                summary: { errors: 0, warnings: 0 },
                stage: 'preview',
              },
            };
          }
          if (params.confirmationToken !== 'e2e-preview-token') {
            return { success: false, securityBlocked: true, error: 'Missing confirmation token' };
          }
          return { success: true, skillName: 'safe-skill' };
        });
      });

      const page = await getStableWindow(app);
      await expect(page.getByTestId('main-layout')).toBeVisible();
      await page.getByTestId('sidebar-nav-skills').click();
      await page.getByTestId('skills-actions-button').click();
      await page.getByTestId('skills-upload-action').click();
      await page.locator('#skill-upload-input').setInputFiles({
        name: 'safe-skill.zip',
        mimeType: 'application/zip',
        buffer: Buffer.from('zip-content'),
      });
      await page.getByTestId('skill-upload-submit-button').click();

      await expect(page.getByTestId('skill-permission-review')).toBeVisible();
      await expect(page.getByText(/api\.example\.com/)).toBeVisible();
      await page.getByTestId('skill-permission-confirm-button').click();
      await expect(page.getByTestId('skill-permission-review')).toHaveCount(0);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('labels blocking upload findings separately from warning-only scripts', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      await app.evaluate(async ({ app: _app }) => {
        const { ipcMain } = process.mainModule!.require('electron') as typeof import('electron');
        ipcMain.removeHandler('skill:uploadZip');
        ipcMain.handle('skill:uploadZip', async () => ({
          success: false,
          securityBlocked: true,
          errorCode: 'CONTENT_BLOCKED',
          validationResult: {
            riskLevel: 'high',
            findings: [
              {
                level: 'error',
                category: 'suspicious-url',
                message: 'Suspicious URL in "SKILL.md": Suspicious keyword in URL: "login" — https://example.com/login',
              },
              {
                level: 'warning',
                category: 'file-type',
                message: 'Potentially dangerous script file: "scripts/setup.sh" (extension .sh)',
              },
            ],
            summary: { errors: 1, warnings: 1 },
            stage: 'post-extraction',
          },
        }));
      });

      const page = await getStableWindow(app);
      await expect(page.getByTestId('main-layout')).toBeVisible();
      await page.getByTestId('sidebar-nav-skills').click();
      await page.getByTestId('skills-actions-button').click();
      await page.getByTestId('skills-upload-action').click();
      await page.locator('#skill-upload-input').setInputFiles({
        name: 'agent-browser.zip',
        mimeType: 'application/zip',
        buffer: Buffer.from('zip-content'),
      });
      await page.getByTestId('skill-upload-submit-button').click();

      await expect(page.getByText(/SKILL\.md（包含高风险链接，已阻止上传）/)).toBeVisible();
      await expect(page.getByText(/scripts\/setup\.sh（\.sh 脚本文件，仅提醒）/)).toBeVisible();
    } finally {
      await closeElectronApp(app);
    }
  });
});
