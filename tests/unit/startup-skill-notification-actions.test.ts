import { beforeEach, describe, expect, it, vi } from 'vitest';

const hostApiFetchMock = vi.hoisted(() => vi.fn());
const installSkillMock = vi.hoisted(() => vi.fn());
const updateSkillMock = vi.hoisted(() => vi.fn());
const enableSkillMock = vi.hoisted(() => vi.fn());
const fetchSkillsMock = vi.hoisted(() => vi.fn());

const storeState = vi.hoisted(() => ({
  searchResults: [{
    id: 71,
    slug: '71',
    name: 'Office Assistant',
    description: '',
    version: '1.0.0',
  }],
  skills: [{
    id: 'office-assistant',
    slug: 'office-assistant',
    name: 'Office Assistant',
    description: '',
    enabled: true,
    version: '1.0.0',
    config: {},
    isCore: false,
    isBundled: false,
  }],
  companyInstallMap: { '71': 'office-assistant' } as Record<string, string>,
  companyInstallEntries: {
    '71': {
      packageSlug: 'office-assistant',
      name: 'Office Assistant',
      version: '1.0.0',
    },
  },
  companyInstallByPackageSlug: {} as Record<string, unknown>,
}));

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
}));

vi.mock('@/stores/skills', () => ({
  useSkillsStore: {
    getState: () => ({
      ...storeState,
      installSkill: installSkillMock,
      updateSkill: updateSkillMock,
      enableSkill: enableSkillMock,
      fetchSkills: fetchSkillsMock,
    }),
  },
}));

import {
  runSilentSkillInstall,
  runSilentSkillNotificationAction,
  runSilentSkillUpdate,
} from '@/lib/startup-skill-notification-actions';

function resetStoreState() {
  storeState.skills[0].version = '1.0.0';
  storeState.companyInstallEntries['71'].version = '1.0.0';
  storeState.searchResults[0].version = '1.0.0';
}

describe('startup-skill-notification-actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStoreState();
    installSkillMock.mockResolvedValue('office-assistant');
    updateSkillMock.mockImplementation(async (_slug: string, latestVersion?: string) => {
      if (latestVersion?.trim()) {
        storeState.skills[0].version = latestVersion;
        storeState.companyInstallEntries['71'].version = latestVersion;
        storeState.searchResults[0].version = latestVersion;
      }
      return 'office-assistant';
    });
    enableSkillMock.mockResolvedValue(undefined);
    fetchSkillsMock.mockResolvedValue(undefined);
  });

  it('installs new skills without toast side effects', async () => {
    await expect(runSilentSkillInstall('99')).resolves.toBe('success');
    expect(installSkillMock).toHaveBeenCalledWith('99');
    expect(updateSkillMock).not.toHaveBeenCalled();
    expect(enableSkillMock).toHaveBeenCalled();
    expect(fetchSkillsMock).toHaveBeenCalled();
  });

  it('returns failed when install throws', async () => {
    installSkillMock.mockRejectedValueOnce(new Error('offline'));
    await expect(runSilentSkillInstall('99')).resolves.toBe('failed');
  });

  it('does not update when check-updates fails', async () => {
    hostApiFetchMock.mockRejectedValueOnce(new Error('network'));
    await expect(runSilentSkillUpdate('71')).resolves.toBe('failed');
    expect(updateSkillMock).not.toHaveBeenCalled();
  });

  it('updates only when check-updates reports an update', async () => {
    hostApiFetchMock.mockResolvedValueOnce({
      success: true,
      results: [{
        skill_id: 71,
        has_update: true,
        latest_version: '2.0.0',
      }],
    });

    await expect(runSilentSkillUpdate('71')).resolves.toBe('success');
    expect(updateSkillMock).toHaveBeenCalledWith('71', '2.0.0');
    expect(enableSkillMock).toHaveBeenCalled();
  });

  it('returns success when skill is already latest', async () => {
    hostApiFetchMock.mockResolvedValueOnce({
      success: true,
      results: [{
        skill_id: 71,
        has_update: false,
        latest_version: '1.0.0',
      }],
    });

    await expect(runSilentSkillUpdate('71')).resolves.toBe('success');
    expect(updateSkillMock).not.toHaveBeenCalled();
  });

  it('routes update and new variants through the shared action helper', async () => {
    hostApiFetchMock.mockResolvedValueOnce({
      success: true,
      results: [{
        skill_id: 71,
        has_update: false,
        latest_version: '1.0.0',
      }],
    });

    await expect(runSilentSkillNotificationAction('new', '99')).resolves.toBe('success');
    await expect(runSilentSkillNotificationAction('update', '71')).resolves.toBe('success');
    expect(installSkillMock).toHaveBeenCalledWith('99');
    expect(updateSkillMock).not.toHaveBeenCalled();
  });
});
