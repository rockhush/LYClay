import { expect, type Page } from '@playwright/test';

export async function openSidebarMoreNav(page: Page): Promise<void> {
  await page.getByTestId('sidebar-nav-more').click();
  await expect(page.getByTestId('sidebar-more-nav-panel')).toBeVisible();
}
