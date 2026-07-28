import { beforeEach, describe, expect, it, vi } from 'vitest';

const settingsStub: Record<string, unknown> = {};

vi.mock('@electron/utils/store', () => ({
  getSetting: vi.fn(async (key: string) => settingsStub[key]),
  setSetting: vi.fn(async (key: string, value: unknown) => {
    settingsStub[key] = value;
  }),
}));

vi.mock('@electron/utils/dingtalk-oauth', () => ({
  enrichDingTalkUserProfile: vi.fn(async (user: unknown) => user),
}));

import { resolveLogIdentityContext } from '@electron/utils/log-identity-context';

beforeEach(() => {
  for (const key of Object.keys(settingsStub)) delete settingsStub[key];
});

describe('log identity context', () => {
  it('uses DingTalk jobNumber and username when available', async () => {
    settingsStub.dingtalkUser = {
      jobNumber: 'EMP00123',
      userId: '11427192',
      name: '林一',
    };

    await expect(resolveLogIdentityContext()).resolves.toEqual({
      workNo: 'EMP00123',
      userName: '林一',
      identityMissingReason: null,
    });
  });

  it('falls back to DingTalk userId and records missing-name reason', async () => {
    settingsStub.dingtalkUser = {
      jobNumber: '',
      userId: '11427192',
      name: '',
    };

    await expect(resolveLogIdentityContext()).resolves.toEqual({
      workNo: '11427192',
      userName: '',
      identityMissingReason: 'missing_user_name',
    });
  });

  it('uses empty strings and a reason when DingTalk identity is unavailable', async () => {
    settingsStub.dingtalkUser = null;

    await expect(resolveLogIdentityContext()).resolves.toEqual({
      workNo: '',
      userName: '',
      identityMissingReason: 'missing_dingtalk_user',
    });
  });
});
