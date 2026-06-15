import { closeElectronApp, expect, getStableWindow, test } from './fixtures/electron';

test.describe('model secret confirmation dialog', () => {
  test('shows redacted model-send secret details without persistent approval', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      const page = await getStableWindow(app);
      await expect(page.getByTestId('main-layout')).toBeVisible();

      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.webContents.send('security:confirmation-request', {
          id: 'e2e-model-secret-confirmation',
          kind: 'model-secret',
          source: 'gateway:rpc:chat.send',
          risk: 'high',
          target: {
            summary: '1 secret-like value(s)',
            secretTypes: ['openai-token'],
            excerpts: ['send [REDACTED] to the model'],
          },
          reasons: ['Message content contains secret-like values before model send'],
        });
      });

      const dialog = page.getByTestId('security-confirmation-dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText('Agent 想发送疑似敏感密钥')).toBeVisible();
      await expect(dialog.getByText('1 secret-like value(s)')).toBeVisible();
      await expect(dialog.getByText('openai-token')).toBeVisible();
      await expect(dialog.getByText('send [REDACTED] to the model')).toBeVisible();
      await expect(dialog).not.toContainText('sk-test-secret');
      await expect(dialog.getByRole('button')).toHaveCount(3);
      await expect(dialog.getByRole('button', { name: '永久允许' })).toHaveCount(0);
    } finally {
      await closeElectronApp(app);
    }
  });
});
