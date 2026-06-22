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

const longHistory = Array.from({ length: 12 }, (_, index) => ({
  id: `long-${index}`,
  role: index % 2 === 0 ? 'user' : 'assistant',
  content: '测'.repeat(14000),
  timestamp: Date.now() / 1000 + index,
}));

test.describe('Chat context compression notice', () => {
  test('shows a visible notice when send-time compression runs', async ({ launchElectronApp }) => {
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
            result: { messages: longHistory },
          },
          [stableStringify(['chat.send', null])]: {
            success: true,
            result: { runId: 'compression-run' },
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
                agents: [{ id: 'main', name: 'main', modelRef: 'ly-auto/auto' }],
              },
            },
          },
          [stableStringify(['/api/model-context?modelRef=ly-auto%2Fauto', 'GET'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: { modelRef: 'ly-auto/auto', contextWindow: 128000 },
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
      await page.getByTestId('chat-composer-input').fill('继续');
      await page.getByTestId('chat-composer-send').click();

      const notice = page.getByTestId('chat-context-compression-notice');
      await expect(notice).toBeVisible({ timeout: 30_000 });
      await expect(notice).toContainText('上下文');
      await expect(notice).toContainText(/压缩/);
    } finally {
      await closeElectronApp(app);
    }
  });
});
