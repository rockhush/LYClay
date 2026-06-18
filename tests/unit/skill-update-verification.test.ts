import { describe, expect, it } from 'vitest';
import {
  hasSkillVersionMismatch,
  resolveInstalledVersionForMarketplaceSkill,
  resolveInstalledVersionForUpdateCheck,
} from '@/lib/skill-update-verification';
import type { MarketplaceSkill, Skill } from '@/types/skill';

describe('resolveInstalledVersionForUpdateCheck', () => {
  it('prefers normalized disk version over registry', () => {
    expect(resolveInstalledVersionForUpdateCheck({ version: '1.0.2' }, '2.0.0')).toBe('1.0.2');
  });

  it('falls back to registry when disk version is unknown', () => {
    expect(resolveInstalledVersionForUpdateCheck({ version: 'unknown' }, '1.0.2')).toBe('1.0.2');
  });
});

describe('hasSkillVersionMismatch', () => {
  const marketplaceSkill: MarketplaceSkill = {
    id: 71,
    slug: 'office-assistant',
    name: '办公助手',
    description: '',
    version: '1.0.2',
  };

  const installedSkills: Skill[] = [{
    id: 'office-assistant',
    slug: 'office-assistant',
    name: '办公助手',
    description: '',
    enabled: true,
    version: '1.0.0',
    config: {},
    isCore: false,
    isBundled: false,
  }];

  const companyInstallMap = { '71': 'office-assistant' };
  const companyInstallEntries = {
    '71': {
      packageSlug: 'office-assistant',
      name: '办公助手',
      version: '1.0.2',
    },
  };

  it('detects mismatch when registry says latest but disk is older', () => {
    expect(hasSkillVersionMismatch(
      marketplaceSkill,
      installedSkills,
      companyInstallMap,
      companyInstallEntries,
      '1.0.2',
    )).toBe(true);
  });

  it('returns false when installed version matches expected latest', () => {
    const updatedSkills = [{ ...installedSkills[0], version: '1.0.2' }];
    expect(hasSkillVersionMismatch(
      marketplaceSkill,
      updatedSkills,
      companyInstallMap,
      companyInstallEntries,
      '1.0.2',
    )).toBe(false);
  });
});

describe('resolveInstalledVersionForMarketplaceSkill', () => {
  it('reads version from installed skill on disk', () => {
    const skill: MarketplaceSkill = {
      id: 10,
      slug: 'ppt-maker',
      name: 'PPT制作',
      description: '',
      version: '2.0.0',
    };
    const installedSkills: Skill[] = [{
      id: 'ppt-maker',
      slug: 'ppt-maker',
      name: 'PPT制作',
      description: '',
      enabled: true,
      version: '1.0.0',
      config: {},
      isCore: false,
      isBundled: false,
    }];

    expect(resolveInstalledVersionForMarketplaceSkill(
      skill,
      installedSkills,
      { '10': 'ppt-maker' },
      { '10': { packageSlug: 'ppt-maker', name: 'PPT制作', version: '2.0.0' } },
    )).toBe('1.0.0');
  });
});
