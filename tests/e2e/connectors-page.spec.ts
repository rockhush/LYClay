import { closeElectronApp, expect, getStableWindow, installIpcMocks, test } from './fixtures/electron';
import { openSidebarMoreNav } from './helpers/sidebar-more-nav';

const ipcKey = (path: string, method = 'GET') => JSON.stringify([path, method]);

test.describe('Connectors & MCP settings', () => {
  test('shows connectors page with built-in and custom tabs from sidebar', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      const page = await getStableWindow(app);
      await page.waitForLoadState('domcontentloaded');
      await expect(page.getByTestId('main-layout')).toBeVisible();
      await openSidebarMoreNav(page);
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

  test('shows only the tools discovered for the selected MCP server', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      await installIpcMocks(app, {
        hostApi: {
          [ipcKey('/api/mcp/servers')]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: [{
                name: 'mysql-server',
                type: 'sse',
                url: 'http://10.3.32.208:8080/sse',
                enabled: true,
                connected: true,
                deniedTools: [],
                allowedTools: null,
              }],
            },
          },
          [ipcKey('/api/mcp/config')]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: {
                config: { servers: {} },
                path: 'openclaw.json#mcp.servers',
              },
            },
          },
          [ipcKey('/api/mcp/servers/mysql-server/tools')]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: {
                tools: [
                  'check_connection',
                  'list_connections',
                  'get_databases',
                  'get_tables',
                  'get_schema',
                  'query',
                ],
                denied: [],
                allowed: null,
                gateway: false,
                discoverySource: 'direct',
                discoveryError: null,
              },
            },
          },
        },
      });

      const page = await getStableWindow(app);
      await page.waitForLoadState('domcontentloaded');
      await openSidebarMoreNav(page);
      await page.getByTestId('sidebar-nav-connectors').click();
      await page.getByTestId('connectors-tab-custom').click();

      const card = page.getByTestId('connectors-custom-card');
      await expect(card).toContainText('6 / 6');
      await expect(card).toContainText('check_connection');
      await expect(card).toContainText('query');
      await expect(card).not.toContainText('agents_list');
      await expect(card).not.toContainText('27 / 27');
    } finally {
      await closeElectronApp(app);
    }
  });

  test('saves a disabled HTTP SSE connector with a token query parameter', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      const page = await getStableWindow(app);
      await page.waitForLoadState('domcontentloaded');
      await expect(page.getByTestId('main-layout')).toBeVisible();
      await openSidebarMoreNav(page);
      await page.getByTestId('sidebar-nav-connectors').click();
      await page.getByTestId('connectors-add-custom').click();

      await page.getByTestId('connector-custom-name').fill('query-auth-http-sse');
      await page.getByTestId('connector-custom-transport').click();
      await page.getByTestId('connector-custom-transport-sse').click();
      await page.getByTestId('connector-custom-url').fill(
        'http://api.openai.com/mcp/sse?token=e2e-query-credential',
      );
      await page.getByTestId('connector-custom-disabled').click();
      await page.getByTestId('connector-custom-save').click();

      await expect(page.getByTestId('connectors-custom-card')).toContainText('query-auth-http-sse');
      await expect(page.getByTestId('connectors-custom-card')).toContainText('token=***');
      await expect(page.getByTestId('connectors-custom-card')).not.toContainText('e2e-query-credential');
      await expect(page.getByText(/api-key-assignment/i)).toHaveCount(0);
    } finally {
      await closeElectronApp(app);
    }
  });
});
