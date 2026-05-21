import { closeElectronApp, expect, getStableWindow, installIpcMocks, test } from './fixtures/electron';

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);
  return `{${entries.join(',')}}`;
}

const mockUser = {
  openId: '',
  unionId: 'union-e2e',
  name: 'E2E User',
  avatar: '',
  mobile: '',
  email: '',
  orgEmail: '',
  jobNumber: 'E2E001',
  title: 'Tester',
  workPlace: '',
  userId: 'user-e2e',
  nickname: 'E2E',
  admin: false,
  boss: false,
  senior: false,
  active: true,
  disableStatus: false,
  hideMobile: false,
  realAuthed: true,
  createTime: '',
  hiredDate: 0,
  loginId: '',
  managerUserId: '',
  exclusiveAccount: false,
  exclusiveAccountType: '',
  exclusiveAccountCorpId: '',
  exclusiveAccountCorpName: 'E2E Org',
  deptIdList: [],
  roleList: [],
  leaderInDept: [],
  departmentIds: [],
  leaderUserId: '',
  loginAt: new Date().toISOString(),
};

test.describe('DingTalk startup login gate', () => {
  test('shows DingTalk login before the workspace when no user is signed in', async ({ launchElectronApp }) => {
    const app = await launchElectronApp();

    try {
      await installIpcMocks(app, {
        hostApi: {
          [stableStringify(['/api/settings', 'GET'])]: {
            ok: true,
            data: { status: 200, ok: true, json: { setupComplete: true, language: 'en' } },
          },
          [stableStringify(['/api/dingtalk/user', 'GET'])]: {
            ok: true,
            data: { status: 200, ok: true, json: { success: true, user: null } },
          },
          [stableStringify(['/api/dingtalk/login/start', 'POST'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: {
                success: true,
                loginId: 'login-e2e',
                authorizeUrl: 'https://login.dingtalk.com/oauth2/auth?client_id=e2e',
              },
            },
          },
          [stableStringify(['/api/dingtalk/login/status?loginId=login-e2e', 'GET'])]: {
            ok: true,
            data: { status: 200, ok: true, json: { success: true, status: 'pending' } },
          },
        },
      });

      const page = await getStableWindow(app);
      await page.reload();

      await expect(page.getByTestId('login-page')).toBeVisible();
      await expect(page.getByText('Welcome to LYClaw')).toBeVisible();
      await expect(page.getByText('Lingyi AI Assistant')).toHaveCount(0);
      await expect(page.getByText('Complete tasks professionally with LYClaw')).toHaveCount(0);
      await expect(page.getByTestId('dingtalk-login-frame')).toHaveAttribute('src', /login\.dingtalk\.com/);
      await expect(page.getByTestId('main-layout')).toHaveCount(0);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('shows post-login agent warmup before entering the workspace', async ({ launchElectronApp }) => {
    const app = await launchElectronApp();

    try {
      await installIpcMocks(app, {
        hostApi: {
          [stableStringify(['/api/settings', 'GET'])]: {
            ok: true,
            data: { status: 200, ok: true, json: { setupComplete: true, language: 'en' } },
          },
          [stableStringify(['/api/gateway/status', 'GET'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: { state: 'running', gatewayReady: true, warmupStatus: 'warming' },
            },
          },
          [stableStringify(['/api/dingtalk/user', 'GET'])]: {
            ok: true,
            data: { status: 200, ok: true, json: { success: true, user: mockUser } },
          },
          [stableStringify(['/api/dingtalk/channel-auto-from-env', 'GET'])]: {
            ok: true,
            data: { status: 200, ok: true, json: { success: true, active: false } },
          },
          [stableStringify(['/api/dingtalk/welcome/send', 'POST'])]: {
            ok: true,
            data: { status: 200, ok: true, json: { success: true } },
          },
        },
      });

      const page = await getStableWindow(app);
      await page.reload();

      await expect(page.getByTestId('post-login-warmup')).toBeVisible();
      await expect(page.getByText('Welcome to LYClaw')).toBeVisible();
      await expect(page.getByText('Lingyi AI Assistant')).toHaveCount(0);
      await expect(page.getByText('Complete tasks professionally with LYClaw')).toHaveCount(0);
      await expect(page.getByText('Agent is preparing the workspace. Please wait...')).toBeVisible();
      await expect(page.getByTestId('main-layout')).toHaveCount(0);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('returns to DingTalk login after logging out from settings', async ({ launchElectronApp }) => {
    const app = await launchElectronApp();

    try {
      await installIpcMocks(app, {
        hostApi: {
          [stableStringify(['/api/settings', 'GET'])]: {
            ok: true,
            data: { status: 200, ok: true, json: { setupComplete: true, language: 'en' } },
          },
          [stableStringify(['/api/gateway/status', 'GET'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: { state: 'running', gatewayReady: true, warmupStatus: 'ready' },
            },
          },
          [stableStringify(['/api/dingtalk/user', 'GET'])]: {
            ok: true,
            data: { status: 200, ok: true, json: { success: true, user: mockUser } },
          },
          [stableStringify(['/api/dingtalk/channel-auto-from-env', 'GET'])]: {
            ok: true,
            data: { status: 200, ok: true, json: { success: true, active: false } },
          },
          [stableStringify(['/api/dingtalk/welcome/send', 'POST'])]: {
            ok: true,
            data: { status: 200, ok: true, json: { success: true } },
          },
          [stableStringify(['/api/dingtalk/logout', 'POST'])]: {
            ok: true,
            data: { status: 200, ok: true, json: { success: true } },
          },
        },
      });

      const page = await getStableWindow(app);
      await page.reload();

      await expect(page.getByTestId('main-layout')).toBeVisible();
      await expect(page.getByTestId('sidebar-user-profile')).toContainText('E2E User');
      await expect(page.getByTestId('sidebar-user-profile')).toContainText('E2E Org');
      await page.getByTestId('sidebar-user-profile').click();
      await page.getByTestId('sidebar-nav-settings').click();
      await page.getByRole('button', { name: 'Logout' }).click();

      await expect(page.getByTestId('login-page')).toBeVisible();
      await expect(page.getByTestId('main-layout')).toHaveCount(0);
    } finally {
      await closeElectronApp(app);
    }
  });
});
