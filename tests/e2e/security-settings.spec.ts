import { closeElectronApp, expect, getStableWindow, test } from './fixtures/electron';

test.describe('Security settings', () => {
  test('opens security grants page from hash route', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      const page = await getStableWindow(app);
      await page.waitForLoadState('domcontentloaded');
      const currentUrl = page.url();
      const base = currentUrl.includes('#') ? currentUrl.slice(0, currentUrl.indexOf('#')) : currentUrl;
      await page.goto(`${base}#/settings/security`);

      await expect(page.getByTestId('security-settings-page')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole('heading', { name: '安全授权' })).toBeVisible();
      await expect(page.getByRole('heading', { name: '域名授权' })).toBeVisible();
      await expect(page.getByRole('heading', { name: '文件与 Workspace 授权' })).toBeVisible();
      // MCP / Skill / command grant sections were removed from the page.
      await expect(page.getByRole('heading', { name: 'Skill 授权' })).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'MCP 服务授权' })).toHaveCount(0);
      await expect(page.getByRole('heading', { name: '命令授权' })).toHaveCount(0);
      await expect(page.getByLabel('域名')).toBeVisible();
      await page.getByRole('tab', { name: '审计日志' }).click();
      await expect(page.getByRole('heading', { name: '审计日志' })).toBeVisible();
      await expect(page.getByLabel('能力')).toBeVisible();
      await expect(page.getByRole('option', { name: 'Skill 运行时' })).toBeVisible();
      await expect(page.getByRole('option', { name: '内部命令' })).toBeVisible();
      await expect(page.getByLabel('结果')).toBeVisible();
    } finally {
      await closeElectronApp(app);
    }
  });
});
