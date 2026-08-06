import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildInstalledSkillsForBatchUpdate,
  detectNewUninstalledSkills,
  resolveSkillUpdateTarget,
} from '@/lib/skill-update-check';
import { useSkillsStore } from '@/stores/skills';
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

describe('detectNewUninstalledSkills', () => {
  const now = Date.parse('2026-08-06T12:00:00');

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

  beforeEach(() => {
    useSkillsStore.setState({
      searchResults: [],
      skills: [],
      companyInstallMap: {},
      companyInstallEntries: {},
      companyInstallByPackageSlug: {},
    });
  });

  it('includes uninstalled skills created within 3 days', () => {
    const newSkill: MarketplaceSkill = {
      id: 99,
      slug: '99',
      name: 'PPT生成',
      description: '',
      version: '1.0.0',
      create_time: '2026-08-05 10:00:00',
    };

    useSkillsStore.setState({
      searchResults: [newSkill],
      skills: [],
      companyInstallMap: {},
    });

    expect(detectNewUninstalledSkills(now)).toEqual([
      { slug: '99', name: 'PPT生成' },
    ]);
  });

  it('excludes installed skills even when recently created', () => {
    const installedMarketplaceSkill: MarketplaceSkill = {
      id: 71,
      slug: '71',
      name: '办公助手',
      description: '',
      version: '1.0.0',
      create_time: '2026-08-06 08:00:00',
    };

    useSkillsStore.setState({
      searchResults: [installedMarketplaceSkill],
      skills: [installedSkill],
      companyInstallMap: { '71': 'office-assistant' },
    });

    expect(detectNewUninstalledSkills(now)).toEqual([]);
  });

  it('excludes uninstalled skills older than 3 days', () => {
    const oldSkill: MarketplaceSkill = {
      id: 88,
      slug: '88',
      name: '旧技能',
      description: '',
      version: '1.0.0',
      create_time: '2026-07-01 10:00:00',
    };

    useSkillsStore.setState({
      searchResults: [oldSkill],
      skills: [],
      companyInstallMap: {},
    });

    expect(detectNewUninstalledSkills(now)).toEqual([]);
  });

  it('excludes skills without create_time', () => {
    const noCreateTime: MarketplaceSkill = {
      id: 77,
      slug: '77',
      name: '无时间技能',
      description: '',
      version: '1.0.0',
    };

    useSkillsStore.setState({
      searchResults: [noCreateTime],
      skills: [],
      companyInstallMap: {},
    });

    expect(detectNewUninstalledSkills(now)).toEqual([]);
  });
});
