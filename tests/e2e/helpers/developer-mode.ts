import type { Page } from '@playwright/test';
import { expect } from '../fixtures/electron';

/** Enable developer mode for E2E via main-process settings (UI toggle is hidden). */
export async function enableDeveloperMode(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await window.electron.ipcRenderer.invoke('settings:set', 'devModeUnlocked', true);
  });
  await page.reload();
  await expect(page.getByTestId('main-layout')).toBeVisible();
}
