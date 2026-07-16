import { closeElectronApp, expect, getStableWindow, installIpcMocks, test } from './fixtures/electron';

const RETIRED_AGENT_ID = 'employee-recruitment-specialist-128348c9';
const RETIRED_SESSION_KEY = `agent:${RETIRED_AGENT_ID}:main`;
const RETIRED_DISPLAY_NAME = '招聘数字员工';

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);
  return `{${entries.join(',')}}`;
}

test.describe('retired digital employee sessions', () => {
  test('keeps human display name and disables chat composer after uninstall', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      const gatewayStatus = {
        state: 'running',
        port: 18789,
        pid: 12345,
        gatewayReady: true,
        warmupStatus: 'ready',
      };

      await installIpcMocks(app, {
        gatewayStatus,
        gatewayRpc: {
          [stableStringify(['sessions.list', {}])]: {
            success: true,
            result: {
              sessions: [
                { key: 'agent:main:main', displayName: 'main' },
                { key: RETIRED_SESSION_KEY, displayName: RETIRED_AGENT_ID },
              ],
            },
          },
          [stableStringify(['chat.history', { sessionKey: RETIRED_SESSION_KEY, limit: 200 }])]: {
            success: true,
            result: {
              messages: [
                { role: 'user', content: 'hello from retired session' },
                { role: 'assistant', content: 'retired session reply' },
              ],
            },
          },
          [stableStringify(['chat.history', { sessionKey: RETIRED_SESSION_KEY, limit: 1000 }])]: {
            success: true,
            result: {
              messages: [
                { role: 'user', content: 'hello from retired session' },
                { role: 'assistant', content: 'retired session reply' },
              ],
            },
          },
        },
        hostApi: {
          [stableStringify(['/api/settings', 'GET'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: {
                language: 'zh',
                setupComplete: true,
              },
            },
          },
          [stableStringify(['/api/ui-state', 'GET'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: {
                success: true,
                state: {
                  version: 1,
                  updatedAt: Date.now(),
                  workspaces: {
                    currentWorkspaceId: null,
                    currentWorkspacePath: null,
                    temporaryWorkspaces: [],
                  },
                  chat: {
                    sessionWorkspaceIds: {},
                    customSessionLabels: {},
                    sessionPinnedAt: {},
                    sessionLastActivity: {},
                    sessionCompressionState: {},
                  },
                  skills: {
                    cachedDisplayMetadata: {},
                    cachedDisplayVersions: {},
                  },
                  digitalEmployees: {
                    cachedDisplayMetadata: {},
                    retiredAgents: {
                      [RETIRED_AGENT_ID]: {
                        agentId: RETIRED_AGENT_ID,
                        name: RETIRED_DISPLAY_NAME,
                        marketEmployeeId: 'employee-recruitment-specialist',
                        retiredAt: '2026-07-07T00:00:00.000Z',
                      },
                    },
                  },
                },
              },
            },
          },
          [stableStringify(['/api/ui-state', 'PUT'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: { success: true },
            },
          },
          [stableStringify(['/api/digital-employees', 'GET'])]: {
            ok: true,
            data: { status: 200, ok: true, json: [] },
          },
          [stableStringify(['/api/agents', 'GET'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: {
                agents: [{ id: 'main', name: 'Main Agent' }],
                defaultAgentId: 'main',
              },
            },
          },
          [stableStringify(['/api/gateway/status', 'GET'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: gatewayStatus,
            },
          },
        },
      });

      const page = await getStableWindow(app);
      await expect(page.getByTestId('main-layout')).toBeVisible();

      await page.getByTestId(`sidebar-session-${RETIRED_SESSION_KEY}`).click();

      const sidebarSession = page.getByTestId(`sidebar-session-${RETIRED_SESSION_KEY}`);
      await expect(sidebarSession.getByText(RETIRED_DISPLAY_NAME)).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('main-content').getByText(RETIRED_DISPLAY_NAME)).toBeVisible();
      await expect(page.getByText(RETIRED_AGENT_ID)).toHaveCount(0);
      await expect(page.getByText('retired session reply')).toBeVisible();

      const composer = page.getByTestId('chat-composer-input');
      await expect(composer).toBeVisible();
      await expect(composer).toBeDisabled();
      await expect(composer).toHaveAttribute(
        'placeholder',
        '该岗位助理已卸载，当前会话仅供查看历史记录',
      );
      await expect(page.getByTestId('chat-composer-send')).toBeDisabled();
    } finally {
      await closeElectronApp(app);
    }
  });
});
