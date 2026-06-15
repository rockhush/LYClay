import { closeElectronApp, expect, getStableWindow, installIpcMocks, test } from './fixtures/electron';

const MAIN_SESSION_KEY = 'agent:main:main';

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${(value as unknown[]).map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);
  return `{${entries.join(',')}}`;
}

test.describe('ClawX main navigation without setup flow', () => {
  test('navigates between core pages with setup bypassed', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      const page = await getStableWindow(app);

      await expect(page.getByTestId('main-layout')).toBeVisible();

      await page.getByTestId('sidebar-nav-models').click();
      await expect(page.getByTestId('models-page')).toBeVisible();
      await expect(page.getByTestId('models-page-title')).toBeVisible();

      await page.getByTestId('sidebar-nav-digital-employee').click();
      await expect(page.getByRole('heading', { name: '数字员工' })).toBeVisible();

      await page.getByTestId('sidebar-nav-skills').click();
      await expect(page.getByTestId('skills-actions-button')).toBeVisible();

      await page.getByTestId('sidebar-nav-channels').click();
      await expect(page.getByTestId('channels-page')).toBeVisible();

      await page.getByTestId('sidebar-nav-connectors').click();
      await expect(page.getByTestId('connectors-page')).toBeVisible();
    } finally {
      await closeElectronApp(app);
    }
  });

  test('does not mount a default workspace but keeps manual picker available', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      const page = await getStableWindow(app);

      await expect(page.getByTestId('main-layout')).toBeVisible();
      await expect(page.getByTestId('sidebar-workspaces-section')).toHaveCount(0);

      await page.getByTestId('workspace-picker-button').click();
      await expect(page.getByTestId('workspace-picker-menu')).toBeVisible();
      await expect(page.getByText('No workspace selected')).toBeVisible();
      await expect(page.getByText('Open Local Folder')).toBeVisible();
    } finally {
      await closeElectronApp(app);
    }
  });

  test('sidebar workspace row has no directory refresh control', async ({ launchElectronApp, homeDir }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      const page = await getStableWindow(app);

      await page.evaluate((workspacePath) => {
        const workspace = {
          id: 'temp-e2e-workspace',
          name: 'E2E Workspace',
          agentId: 'temp',
          agentName: 'E2E Workspace',
          path: workspacePath,
          createdAt: Date.now(),
          lastAccessedAt: Date.now(),
        };
        window.localStorage.setItem('LYClaw-workspaces', JSON.stringify({
          state: {
            currentWorkspaceId: workspace.id,
            currentWorkspacePath: workspace.path,
            temporaryWorkspaces: [workspace],
          },
          version: 0,
        }));
      }, homeDir);
      await page.reload();

      await expect(page.getByTestId('sidebar-workspaces-section')).toBeVisible();
      await expect(page.getByTestId('sidebar-workspace-row-temp-e2e-workspace')).toBeVisible();
      await expect(page.getByTestId('sidebar-workspace-refresh-temp-e2e-workspace')).toHaveCount(0);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('lists sessions bound to a workspace under that workspace row', async ({ launchElectronApp, homeDir }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      const gatewayStatus = {
        state: 'running',
        port: 18789,
        pid: 12345,
        gatewayReady: true,
      };

      await installIpcMocks(app, {
        gatewayStatus,
        gatewayRpc: {
          [stableStringify(['sessions.list', {}])]: {
            success: true,
            result: {
              sessions: [{ key: MAIN_SESSION_KEY, displayName: 'main' }],
            },
          },
          [stableStringify(['chat.history', { sessionKey: MAIN_SESSION_KEY, limit: 200 }])]: {
            success: true,
            result: { messages: [] },
          },
        },
        hostApi: {
          [stableStringify(['/api/gateway/status', 'GET'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: gatewayStatus,
            },
          },
          [stableStringify(['/api/agents', 'GET'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: {
                success: true,
                agents: [{ id: 'main', name: 'Main Agent' }],
              },
            },
          },
        },
      });

      const page = await getStableWindow(app);
      await page.evaluate(
        ({ workspacePath, sessionMapJson }) => {
          const workspace = {
            id: 'temp-e2e-workspace',
            name: 'E2E Workspace',
            agentId: 'temp',
            agentName: 'E2E Workspace',
            path: workspacePath,
            createdAt: Date.now(),
            lastAccessedAt: Date.now(),
          };
          window.localStorage.setItem(
            'LYClaw-workspaces',
            JSON.stringify({
              state: {
                currentWorkspaceId: workspace.id,
                currentWorkspacePath: workspace.path,
                temporaryWorkspaces: [workspace],
              },
              version: 0,
            }),
          );
          window.localStorage.setItem('LYClaw:chat:session-workspace-ids', sessionMapJson);
        },
        {
          workspacePath: homeDir,
          sessionMapJson: JSON.stringify({ [MAIN_SESSION_KEY]: 'temp-e2e-workspace' }),
        },
      );
      await page.reload();

      await expect(page.getByTestId('sidebar-workspaces-section')).toBeVisible({ timeout: 30_000 });
      const nested = page.getByTestId('sidebar-workspace-sessions-temp-e2e-workspace');
      await expect(nested).toBeVisible();
      await expect(nested.getByTestId(`sidebar-session-${MAIN_SESSION_KEY}`)).toBeVisible();

      await page.getByTestId('sidebar-workspace-chats-toggle-temp-e2e-workspace').click();
      await expect(nested.getByTestId(`sidebar-session-${MAIN_SESSION_KEY}`)).toHaveCount(0);
      await page.getByTestId('sidebar-workspace-chats-toggle-temp-e2e-workspace').click();
      await expect(nested.getByTestId(`sidebar-session-${MAIN_SESSION_KEY}`)).toBeVisible();
    } finally {
      await closeElectronApp(app);
    }
  });
});
