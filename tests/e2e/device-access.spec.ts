import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { closeElectronApp, expect, test } from './fixtures/electron';

async function startDeviceAccessServer(allowed: boolean): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.end();
      return;
    }

    let rawBody = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      rawBody += chunk;
    });
    req.on('end', () => {
      const body = JSON.parse(rawBody || '{}') as Record<string, unknown>;
      const receivedExpectedBody = body.token === 'test-device-token' && body.os_type === 'windows';
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({
        success: true,
        exists: receivedExpectedBody ? allowed : true,
        message: receivedExpectedBody && !allowed ? 'Token不存在' : 'Token存在',
      }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to start device access server');
  }

  return {
    url: `http://127.0.0.1:${address.port}/device-access`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test.describe('device access gate', () => {
  test('blocks the app when the device is not company-managed', async ({ launchElectronApp }) => {
    const deviceAccess = await startDeviceAccessServer(false);
    const app = await launchElectronApp({
      env: {
        CLAWX_DEVICE_ACCESS_URL: deviceAccess.url,
        CLAWX_DEVICE_ACCESS_AUTH_TOKEN: 'test-api-token',
        CLAWX_DEVICE_ACCESS_DEVICE_TOKEN: 'test-device-token',
        CLAWX_DEVICE_ACCESS_OS_TYPE: 'windows',
        CLAWX_DEVICE_ACCESS_CACHE_TTL_MS: '60000',
      },
    });

    try {
      const page = await app.firstWindow();
      await page.waitForLoadState('domcontentloaded');

      await expect(page.getByTestId('device-access-gate')).toBeVisible();
      await expect(page.getByText('仅限公司电脑使用')).toBeVisible();
      await expect(page.getByTestId('setup-page')).toHaveCount(0);
      await expect(page.getByTestId('login-page')).toHaveCount(0);
    } finally {
      await closeElectronApp(app);
      await deviceAccess.close();
    }
  });
});
