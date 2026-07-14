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
      await expect(page.getByTestId('security-mode-section')).toBeVisible();
      await expect(page.getByTestId('security-mode-standard')).toBeVisible();
      await expect(page.getByTestId('security-mode-trusted')).toBeVisible();
      await expect(page.getByTestId('security-mode-trusted')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('security-mode-off')).toBeVisible();
      await expect(page.getByRole('heading', { name: '瀹夊叏鎺堟潈' })).toBeVisible();
      await expect(page.getByRole('heading', { name: '鍩熷悕鎺堟潈' })).toBeVisible();
      await expect(page.getByRole('heading', { name: '鏂囦欢涓?Workspace 鎺堟潈' })).toBeVisible();
      // MCP / Skill / command grant sections were removed from the page.
      await expect(page.getByRole('heading', { name: 'Skill 鎺堟潈' })).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'MCP 鏈嶅姟鎺堟潈' })).toHaveCount(0);
      await expect(page.getByRole('heading', { name: '鍛戒护鎺堟潈' })).toHaveCount(0);
      await expect(page.getByLabel('鍩熷悕')).toBeVisible();
      await page.getByRole('tab', { name: '瀹¤鏃ュ織' }).click();
      await expect(page.getByRole('heading', { name: '瀹¤鏃ュ織' })).toBeVisible();
      await expect(page.getByLabel('鑳藉姏')).toBeVisible();
      await expect(page.getByRole('option', { name: 'Skill 杩愯鏃? })).toBeVisible();
      await expect(page.getByRole('option', { name: '鍐呴儴鍛戒护' })).toBeVisible();
      await expect(page.getByLabel('缁撴灉')).toBeVisible();
    } finally {
      await closeElectronApp(app);
    }
  });
});

