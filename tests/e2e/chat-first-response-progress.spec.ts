import { closeElectronApp, expect, getStableWindow, installIpcMocks, test } from './fixtures/electron';

const MAIN_SESSION_KEY = 'agent:main:main';

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);
  return `{${entries.join(',')}}`;
}

test.describe('Chat first response progress', () => {
  test('shows live run activity instead of a bare typing indicator', async ({ launchElectronApp }) => {
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
              sessions: [{ key: MAIN_SESSION_KEY, displayName: 'main' }],
            },
          },
          [stableStringify(['chat.history', { sessionKey: MAIN_SESSION_KEY, limit: 200 }])]: {
            success: true,
            result: { messages: [] },
          },
          [stableStringify(['chat.send', null])]: {
            success: true,
            result: { runId: 'visible-activity-run' },
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
                agents: [{ id: 'main', name: 'main' }],
              },
            },
          },
        },
      });

      const page = await getStableWindow(app);
      try {
        await page.reload();
      } catch (error) {
        if (!String(error).includes('ERR_FILE_NOT_FOUND')) {
          throw error;
        }
      }

      await expect(page.getByTestId('chat-composer-input')).toBeVisible({ timeout: 30_000 });
      await page.getByTestId('chat-composer-input').fill('Start a long task');
      await page.getByTestId('chat-composer-send').click();

      const activity = page.getByTestId('chat-run-activity');
      await expect(activity).toBeVisible({ timeout: 30_000 });
      await expect(activity).toContainText('\u8bf7\u6c42\u5df2\u53d1\u9001');
      await expect(activity).toContainText('\u5df2\u8fd0\u884c');
    } finally {
      await closeElectronApp(app);
    }
  });

  test('shows spawned-subtask status instead of waiting-for-model copy', async ({ launchElectronApp }) => {
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
              sessions: [{ key: MAIN_SESSION_KEY, displayName: 'main' }],
            },
          },
          [stableStringify(['chat.history', { sessionKey: MAIN_SESSION_KEY, limit: 200 }])]: {
            success: true,
            result: {
              messages: [
                { id: 'u1', role: 'user', content: 'Build the dashboard', timestamp: 1 },
                {
                  id: 'a1',
                  role: 'assistant',
                  timestamp: 2,
                  content: [
                    { type: 'text', text: 'Delegating the implementation.' },
                    {
                      type: 'toolCall',
                      id: 'spawn-1',
                      name: 'sessions_spawn',
                      input: { label: 'questionnaire-dashboard-builder' },
                    },
                  ],
                },
              ],
            },
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
                agents: [{ id: 'main', name: 'main' }],
              },
            },
          },
        },
      });

      const page = await getStableWindow(app);
      try {
        await page.reload();
      } catch (error) {
        if (!String(error).includes('ERR_FILE_NOT_FOUND')) {
          throw error;
        }
      }

      const activity = page.getByTestId('chat-run-activity');
      await expect(activity).toBeVisible({ timeout: 30_000 });
      await expect(activity).toContainText('\u5df2\u6d3e\u53d1\u5b50\u4efb\u52a1');
      await expect(activity).toContainText('questionnaire-dashboard-builder');
      await expect(activity).not.toContainText('\u7b49\u5f85\u6a21\u578b\u54cd\u5e94');
    } finally {
      await closeElectronApp(app);
    }
  });

  test('renders the warming progress card in the conversation after sending', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      const gatewayStatus = {
        state: 'running',
        port: 18789,
        pid: 12345,
        gatewayReady: true,
        warmupStatus: 'warming',
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
          [stableStringify(['chat.send', null])]: {
            success: true,
            result: { runId: 'warming-run' },
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
                agents: [{ id: 'main', name: 'main' }],
              },
            },
          },
          [stableStringify(['/api/app/first-response-mascot', 'GET'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: {
                success: true,
                dataUrl: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxIiBoZWlnaHQ9IjEiIC8+',
              },
            },
          },
        },
      });

      const page = await getStableWindow(app);
      try {
        await page.reload();
      } catch (error) {
        if (!String(error).includes('ERR_FILE_NOT_FOUND')) {
          throw error;
        }
      }

      await expect(page.getByTestId('chat-composer-input')).toBeVisible({ timeout: 30_000 });
      await page.getByTestId('chat-composer-input').fill('Start the first run');
      await page.getByTestId('chat-composer-send').click();

      const progressCard = page.getByTestId('first-response-progress-card');
      await expect(progressCard).toBeVisible({ timeout: 30_000 });
      await expect(progressCard.locator('img')).toBeVisible();
      await expect(progressCard.getByRole('progressbar')).toBeVisible();
    } finally {
      await closeElectronApp(app);
    }
  });

  test('disables switching to another session while first-response preparing is shown', async ({ launchElectronApp }) => {
    const SECOND_SESSION_KEY = 'agent:main:side';
    const app = await launchElectronApp({ skipSetup: true });

    try {
      const gatewayStatus = {
        state: 'running',
        port: 18789,
        pid: 12345,
        gatewayReady: true,
        warmupStatus: 'warming',
      };

      await installIpcMocks(app, {
        gatewayStatus,
        gatewayRpc: {
          [stableStringify(['sessions.list', {}])]: {
            success: true,
            result: {
              sessions: [
                { key: MAIN_SESSION_KEY, displayName: 'main' },
                { key: SECOND_SESSION_KEY, displayName: 'side' },
              ],
            },
          },
          [stableStringify(['chat.history', { sessionKey: MAIN_SESSION_KEY, limit: 200 }])]: {
            success: true,
            result: { messages: [] },
          },
          [stableStringify(['chat.history', { sessionKey: SECOND_SESSION_KEY, limit: 200 }])]: {
            success: true,
            result: { messages: [{ role: 'user', content: 'Other', timestamp: 1 }] },
          },
          [stableStringify(['chat.send', null])]: {
            success: true,
            result: { runId: 'warming-run' },
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
                agents: [{ id: 'main', name: 'main' }],
              },
            },
          },
          [stableStringify(['/api/app/first-response-mascot', 'GET'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: {
                success: true,
                dataUrl: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxIiBoZWlnaHQ9IjEiIC8+',
              },
            },
          },
        },
      });

      const page = await getStableWindow(app);
      try {
        await page.reload();
      } catch (error) {
        if (!String(error).includes('ERR_FILE_NOT_FOUND')) {
          throw error;
        }
      }

      await expect(page.getByTestId('chat-composer-input')).toBeVisible({ timeout: 30_000 });
      await page.getByTestId('chat-composer-input').fill('Start the first run');
      await page.getByTestId('chat-composer-send').click();

      await expect(page.getByTestId('first-response-progress-card')).toBeVisible({ timeout: 30_000 });

      const otherSession = page.getByTestId(`sidebar-session-${SECOND_SESSION_KEY}`);
      await expect(otherSession).toBeVisible({ timeout: 15_000 });
      await expect(otherSession).toBeDisabled();
    } finally {
      await closeElectronApp(app);
    }
  });

  test('lets the user switch the reasoning mode from the composer', async ({ launchElectronApp }) => {
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
                agents: [{ id: 'main', name: 'main' }],
              },
            },
          },
        },
      });

      const page = await getStableWindow(app);
      try {
        await page.reload();
      } catch (error) {
        if (!String(error).includes('ERR_FILE_NOT_FOUND')) {
          throw error;
        }
      }

      const modeButton = page.getByTestId('chat-reasoning-mode-button');
      await expect(modeButton).toBeVisible({ timeout: 30_000 });
      await modeButton.click();
      await expect(page.getByTestId('chat-reasoning-mode-menu')).toBeVisible();

      await page.getByTestId('chat-reasoning-mode-expert').click();
      await expect(modeButton).toContainText('Expert');
    } finally {
      await closeElectronApp(app);
    }
  });
});

