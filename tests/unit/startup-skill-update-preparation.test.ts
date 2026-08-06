import { beforeEach, describe, expect, it, vi } from 'vitest';

const hostApiFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/host-api', () => ({
  getHostApiBase: () => 'http://127.0.0.1:18789',
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
}));

import { prepareSkillUpdateCheck } from '@/lib/skill-update-check';
import { useSkillsStore } from '@/stores/skills';
import type { MarketplaceSkill } from '@/types/skill';

const marketplaceSkill: MarketplaceSkill = {
  id: 71,
  slug: '71',
  name: 'Office Assistant',
  description: '',
  version: '1.0.0',
};

const companyEntry = {
  packageSlug: 'office-assistant',
  name: 'Office Assistant',
  version: '1.0.0',
};

describe('prepareSkillUpdateCheck', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSkillsStore.setState({
      searchResults: [],
      marketplaceCatalogLoaded: false,
      companyInstallMap: {},
      companyInstallEntries: {},
      companyInstallByPackageSlug: {},
      searching: false,
      searchError: null,
    });
  });

  it('does not reload marketplace or install metadata when both are cached', async () => {
    useSkillsStore.setState({
      searchResults: [marketplaceSkill],
      marketplaceCatalogLoaded: true,
      companyInstallMap: { '71': 'office-assistant' },
      companyInstallEntries: { '71': companyEntry },
      companyInstallByPackageSlug: {
        'office-assistant': { ...companyEntry, marketplaceId: '71' },
      },
    });

    await prepareSkillUpdateCheck();

    expect(hostApiFetchMock).not.toHaveBeenCalled();
  });

  it('loads only the missing install metadata when the catalog is cached', async () => {
    useSkillsStore.setState({
      searchResults: [marketplaceSkill],
      marketplaceCatalogLoaded: true,
    });
    hostApiFetchMock.mockResolvedValueOnce({
      success: true,
      installs: { '71': 'office-assistant' },
      entries: { '71': companyEntry },
      byPackageSlug: {
        'office-assistant': { ...companyEntry, marketplaceId: '71' },
      },
    });

    await prepareSkillUpdateCheck();

    expect(hostApiFetchMock).toHaveBeenCalledTimes(1);
    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/clawhub/company-install-map');
  });

  it('loads the catalog and install metadata when neither is available', async () => {
    hostApiFetchMock.mockImplementation(async (path: string) => (
      path === '/api/clawhub/search'
        ? { success: true, results: [marketplaceSkill] }
        : { success: true, installs: {}, entries: {}, byPackageSlug: {} }
    ));

    await prepareSkillUpdateCheck();

    expect(hostApiFetchMock).toHaveBeenCalledWith(
      '/api/clawhub/search',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/clawhub/company-install-map');
  });
});
