import {
  closeElectronApp,
  expect,
  getStableWindow,
  installIpcMocks,
  test,
} from './fixtures/electron';

test.describe('digital employee marketplace installation', () => {
  test('installs a marketplace employee from its card', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installIpcMocks(app, {
        hostApi: {
          '["/api/digital-employees","GET"]': {
            ok: true,
            data: { status: 200, ok: true, json: [] },
          },
          '["/api/digital-employee/marketplace/list","POST"]': {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: {
                success: true,
                results: [{
                  slug: '7',
                  name: 'test11',
                  description: '',
                  version: '1.0.0',
                  author: '龙鸣',
                  downloads: 3,
                  updateTime: '2026-06-11 17:49:28',
                  category: 'rnd',
                  installed: false,
                  tags: ['test'],
                }],
              },
            },
          },
          '["/api/digital-employees/install","POST"]': {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: {
                success: true,
                instanceId: 'document-analyst--12345678',
                agentId: 'employee-document-analyst-12345678',
                sessionKey: 'agent:employee-document-analyst-12345678:main',
                status: 'active',
                warnings: [],
              },
            },
          },
          '["/api/agents","GET"]': {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: { agents: [], defaultAgentId: null },
            },
          },
        },
      });

      const page = await getStableWindow(app);
      await page.getByTestId('sidebar-nav-digital-employee').click();
      await page.getByRole('button', { name: '岗位助理广场' }).click();

      await expect(page.getByText('test11')).toBeVisible();
      await page.getByTestId('digital-employee-install-7').click();

      await expect(page.getByText('“test11”安装成功')).toBeVisible();
    } finally {
      await closeElectronApp(app);
    }
  });

  test('shows marketplace catalog names for coexisting installs and opens chat from use', async ({ launchElectronApp }) => {
    const plazaInstanceId = 'test11--aaa';
    const localInstanceId = 'document-analyst--bbb';
    const plazaSessionKey = 'agent:employee-test11-aaa:main';
    const localSessionKey = 'agent:employee-document-analyst-bbb:main';

    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installIpcMocks(app, {
        gatewayStatus: {
          state: 'running',
          port: 18789,
          pid: 12345,
          connectedAt: Date.now(),
          gatewayReady: true,
        },
        gatewayRpc: {
          '["sessions.list",null]': {
            success: true,
            result: {
              sessions: [
                { key: 'agent:main:main', displayName: 'main' },
                { key: localSessionKey, displayName: '文档分析岗位助理' },
              ],
            },
          },
          [`["chat.history",{"sessionKey":"${localSessionKey}"}]`]: {
            success: true,
            result: { messages: [] },
          },
        },
        hostApi: {
          '["/api/digital-employees","GET"]': {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: [
                {
                  instanceId: plazaInstanceId,
                  marketEmployeeId: '7',
                  packageId: 'com.lyclaw.employee.test11',
                  packageVersion: '1.0.0',
                  name: 'local-test11-name',
                  description: 'local install',
                  tags: ['local-tag'],
                  installPath: '/tmp/test11',
                  agentId: 'employee-test11-aaa',
                  sessionKey: plazaSessionKey,
                  status: 'active',
                  enabled: true,
                  warnings: [],
                },
                {
                  instanceId: localInstanceId,
                  marketEmployeeId: '8',
                  packageId: 'com.lyclaw.employee.document-analyst',
                  packageVersion: '1.0.1',
                  name: 'local-doc-name',
                  description: 'local install',
                  tags: ['local-tag'],
                  installPath: '/tmp/document-analyst',
                  agentId: 'employee-document-analyst-bbb',
                  sessionKey: localSessionKey,
                  status: 'active',
                  enabled: true,
                  warnings: [],
                },
              ],
            },
          },
          '["/api/digital-employee/marketplace/list","POST"]': {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: {
                success: true,
                results: [
                  {
                    slug: '7',
                    name: 'test11',
                    description: 'plaza catalog',
                    version: '1.0.0',
                    author: '龙鸣',
                    downloads: 3,
                    updateTime: '2026-06-11 17:49:28',
                    category: 'rnd',
                    installed: true,
                    tags: ['test'],
                  },
                  {
                    slug: '8',
                    name: '文档分析岗位助理',
                    description: 'plaza catalog doc',
                    version: '1.0.1',
                    author: '龙鸣',
                    downloads: 5,
                    updateTime: '2026-06-11 17:49:28',
                    category: 'rnd',
                    installed: true,
                    tags: ['文档分析'],
                  },
                ],
              },
            },
          },
          '["/api/agents","GET"]': {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: {
                agents: [
                  { id: 'main', name: 'main' },
                  { id: 'employee-document-analyst-bbb', name: '文档分析岗位助理' },
                ],
                defaultAgentId: 'main',
              },
            },
          },
          '["/api/gateway/status","GET"]': {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: {
                state: 'running',
                port: 18789,
                pid: 12345,
                connectedAt: Date.now(),
                gatewayReady: true,
              },
            },
          },
          '["/api/sessions/history-local","GET"]': {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: { success: true, messages: [] },
            },
          },
        },
      });

      const page = await getStableWindow(app);
      await page.getByTestId('sidebar-nav-digital-employee').click();

      // Display names come from the marketplace catalog, not local manifests.
      await expect(page.getByText('test11')).toBeVisible();
      await expect(page.getByText('文档分析岗位助理')).toBeVisible();
      await expect(page.getByText('local-test11-name')).toHaveCount(0);
      await expect(page.getByText('local-doc-name')).toHaveCount(0);

      await page.getByTestId(`digital-employee-my-use-${localInstanceId}`).click();
      await expect(page.getByTestId('chat-composer-input')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText('文档分析岗位助理')).toBeVisible();
    } finally {
      await closeElectronApp(app);
    }
  });
});
