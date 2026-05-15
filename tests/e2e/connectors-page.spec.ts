import { closeElectronApp, expect, getStableWindow, test } from './fixtures/electron';

test.describe('Connectors & MCP settings', () => {
  test('shows connectors page with built-in and custom tabs from sidebar', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      const page = await getStableWindow(app);
      await page.waitForLoadState('domcontentloaded');
      await expect(page.getByTestId('main-layout')).toBeVisible();
      await page.getByTestId('sidebar-nav-connectors').click();
      await expect(page.getByTestId('connectors-page')).toBeVisible();
      await expect(page.getByTestId('connectors-tab-builtin')).toBeVisible();
      await expect(page.getByTestId('connectors-builtin-empty')).toHaveCount(0);
      await expect(page.getByTestId('connectors-custom-empty')).toHaveCount(0);
      await page.getByTestId('connectors-tab-custom').click();
      await expect(page.getByTestId('connectors-custom-empty')).toBeVisible();
    } finally {
      await closeElectronApp(app);
    }
  });

  test('opens MCP list from hash route', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      const page = await getStableWindow(app);
      await page.waitForLoadState('domcontentloaded');
      const u = page.url();
      const base = u.includes('#') ? u.slice(0, u.indexOf('#')) : u;
      await page.goto(`${base}#/settings/mcp`);
      await expect(page.getByTestId('mcp-settings-page')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId('mcp-settings-search')).toBeVisible();
    } finally {
      await closeElectronApp(app);
    }
  });
});
