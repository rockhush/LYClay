import { completeSetup, expect, test } from './fixtures/electron';
import { enableDeveloperMode } from './helpers/developer-mode';
import { openSidebarMoreNav } from './helpers/sidebar-more-nav';

test.describe('ClawX developer-mode gated UI', () => {
  test('keeps developer-only configuration hidden until dev mode is enabled', async ({ page }) => {
    await completeSetup(page);

    await page.getByTestId('sidebar-nav-settings').click();
    await expect(page.getByTestId('settings-page')).toBeVisible();
    await expect(page.getByTestId('settings-developer-section')).toHaveCount(0);
    await expect(page.getByTestId('settings-dev-mode-switch')).toHaveCount(0);
    await expect(page.getByTestId('sidebar-open-dev-console')).toHaveCount(0);
    await expect(page.getByTestId('sidebar-nav-dreams')).toHaveCount(0);

    await page.evaluate(() => {
      window.location.hash = '#/dreams';
    });
    await expect(page.getByTestId('dreams-page')).toHaveCount(0);
    await expect(page.getByTestId('chat-composer-input')).toBeVisible();

    await openSidebarMoreNav(page);
    await page.getByTestId('sidebar-nav-models').click();
    await page.getByTestId('providers-add-button').click();
    await expect(page.getByTestId('add-provider-dialog')).toBeVisible();
    await expect(page.getByTestId('add-provider-name-input')).toBeVisible();
    await expect(page.getByTestId('add-provider-model-id-input')).toBeVisible();
    await page.getByTestId('add-provider-close-button').click();
    await expect(page.getByTestId('add-provider-dialog')).toHaveCount(0);

    await enableDeveloperMode(page);
    await page.getByTestId('sidebar-nav-settings').click();
    await expect(page.getByTestId('settings-developer-section')).toHaveCount(0);
    await expect(page.getByTestId('settings-developer-gateway-token')).toHaveCount(0);
    await expect(page.getByTestId('sidebar-open-dev-console')).toHaveCount(0);
    await expect(page.getByTestId('sidebar-nav-dreams')).toBeVisible();

    await openSidebarMoreNav(page);
    await page.getByTestId('sidebar-nav-models').click();
    await page.getByTestId('providers-add-button').click();
    await expect(page.getByTestId('add-provider-dialog')).toBeVisible();
    await expect(page.getByTestId('add-provider-model-id-input')).toBeVisible();
  });
});
