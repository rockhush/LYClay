import { closeElectronApp, expect, getStableWindow, test } from './fixtures/electron';

test.describe('MCP server confirmation dialog', () => {
  test('shows stdio MCP server details with persistent approval', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      const page = await getStableWindow(app);
      await expect(page.getByTestId('main-layout')).toBeVisible();

      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.webContents.send('security:confirmation-request', {
          id: 'e2e-mcp-server-confirmation',
          kind: 'mcp-server',
          source: 'settings:mcp-enable',
          risk: 'high',
          target: {
            serverName: 'example-mcp',
            transport: 'stdio',
            summary: 'npx -y @example/mcp',
          },
          reasons: ['stdio MCP servers start a local process and require explicit confirmation'],
        });
      });

      const dialog = page.getByTestId('security-confirmation-dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('example-mcp');
      await expect(dialog).toContainText('stdio');
      await expect(dialog).toContainText('npx -y @example/mcp');
      await expect(dialog.getByRole('button')).toHaveCount(4);
    } finally {
      await closeElectronApp(app);
    }
  });
});
