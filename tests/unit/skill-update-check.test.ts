import { describe, expect, it } from 'vitest';
import {
  buildInstalledSkillsForBatchUpdate,
  resolveSkillUpdateTarget,
} from '@/lib/skill-update-check';
import type { MarketplaceSkill, Skill } from '@/types/skill';

describe('buildInstalledSkillsForBatchUpdate', () => {
  const installedSkill: Skill = {
    id: 'office-assistant',
    slug: 'office-assistant',
    name: '办公助手',
    description: '',
    enabled: true,
    version: '1.0.0',
    config: {},
    isCore: false,
    isBundled: false,
  };

  const marketplaceSkill: MarketplaceSkill = {
    id: 71,
    slug: '71',
    name: '办公助手',
    description: '',
    version: '1.0.0',
  };

  it('includes on-disk installed marketplace skills', () => {
    const result = buildInstalledSkillsForBatchUpdate({
      searchResults: [marketplaceSkill],
      companyInstallEntries: {
        '71': {
          packageSlug: 'office-assistant',
          name: '办公助手',
          version: '1.0.0',
        },
      },
      companyInstallMap: { '71': 'office-assistant' },
      companyInstallByPackageSlug: {},
      skills: [installedSkill],
    });

    expect(result).toHaveLength(1);
    expect(String(result[0].id)).toBe('71');
  });

  it('excludes marketplace skills not present on disk', () => {
    const result = buildInstalledSkillsForBatchUpdate({
      searchResults: [marketplaceSkill],
      companyInstallEntries: {
        '71': {
          packageSlug: 'office-assistant',
          name: '办公助手',
          version: '1.0.0',
        },
      },
      companyInstallMap: { '71': 'office-assistant' },
      companyInstallByPackageSlug: {},
      skills: [],
    });

    expect(result).toHaveLength(0);
  });
});

describe('resolveSkillUpdateTarget', () => {
  it('returns null when marketplace update slug cannot be resolved', () => {
    const skill: MarketplaceSkill = {
      id: 'external-skill',
      slug: 'external-skill',
      name: 'External',
      description: '',
      version: '1.0.0',
    };

    expect(resolveSkillUpdateTarget(skill)).toBeNull();
  });
});
