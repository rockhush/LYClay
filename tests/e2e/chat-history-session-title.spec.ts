import { closeElectronApp, expect, getStableWindow, installIpcMocks, test } from './fixtures/electron';

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);
  return `{${entries.join(',')}}`;
}

test.describe('ClawX chat history titles', () => {
  test('renders first user question previews without loading full history', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installIpcMocks(app, {
        gatewayStatus: { state: 'starting' },
        gatewayRpc: {
          [stableStringify(['chat.history', { sessionKey: 'agent:main:session-title', limit: 200 }])]: {
            success: true,
            result: { messages: [{ role: 'assistant', content: 'full history should not be needed for the sidebar' }] },
          },
        },
        hostApi: {
          [stableStringify(['/api/gateway/status', 'GET'])]: {
            ok: true,
            data: { status: 200, ok: true, json: { state: 'starting' } },
          },
          [stableStringify(['/api/agents', 'GET'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: { success: true, agents: [{ id: 'main', name: 'Main Agent' }] },
            },
          },
          [stableStringify(['/api/sessions/list-local?agentId=main&includePreviews=1', 'GET'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: {
                success: true,
                sessions: [
                  {
                    key: 'agent:main:session-title',
                    label: 'Explain first session latency',
                    firstUserMessagePreview: 'Explain first session latency',
                    displayName: 'LYClaw',
                    updatedAt: Date.now(),
                  },
                ],
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

      await expect(page.getByTestId('main-layout')).toBeVisible();
      await expect(page.getByText('Explain first session latency')).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText('full history should not be needed for the sidebar')).toHaveCount(0);
    } finally {
      await closeElectronApp(app);
    }
  });
});
