import { describe, expect, it, beforeEach } from 'vitest';
import {
  backfillSkillDisplayCacheAliases,
  commitCachedSkillDisplayMetadata,
  parseCompanyListSkillMetadata,
  loadSkillDisplayCacheLegacy,
  lookupCachedSkillDisplayMetadata,
  purgeCachedSkillDisplayMetadataBySlug,
  resolveCachedSkillDisplayMetadata,
  resolveInstalledMarketplaceSkillForDisplay,
  seedCachedSkillDisplayMetadata,
} from '@/lib/skill-display-cache';

describe('skill-display-cache', () => {
  beforeEach(() => {
    loadSkillDisplayCacheLegacy({}, {});
  });

  it('seeds metadata from API only once', () => {
    const skill = { id: '123', slug: 'office-helper', name: '办公助手' };
    const marketplace = {
      id: 123,
      slug: 'office-helper',
      name: '办公助手',
      version: '1.0.0',
      author: 'Alice',
      description: 'Office helper',
      update_time: '2026-06-10',
    };

    expect(seedCachedSkillDisplayMetadata(skill, marketplace, marketplace)).toBe(true);
    expect(lookupCachedSkillDisplayMetadata(skill, marketplace)).toEqual({
      version: '1.0.0',
      name: '办公助手',
      author: 'Alice',
      description: 'Office helper',
      update_time: '2026-06-10',
    });

    expect(seedCachedSkillDisplayMetadata(skill, { ...marketplace, version: '2.0.0' }, marketplace)).toBe(false);
    expect(lookupCachedSkillDisplayMetadata(skill, marketplace)?.version).toBe('1.0.0');
  });

  it('seeds installed skills with local version instead of marketplace list version', () => {
    const installedSkill = {
      id: 'translate-tool',
      slug: 'translate-tool',
      name: '翻译工具',
      version: '1.0.0',
    };
    const marketplace = {
      id: 384,
      slug: 'translate-tool',
      name: '翻译工具',
      version: '1.1.0',
      author: 'Alice',
      description: 'Marketplace description',
      update_time: '2026-06-10',
    };

    expect(seedCachedSkillDisplayMetadata(
      installedSkill,
      marketplace,
      {
        version: installedSkill.version,
        name: marketplace.name,
        author: marketplace.author,
        description: marketplace.description,
        update_time: marketplace.update_time,
      },
      installedSkill,
    )).toBe(true);

    expect(lookupCachedSkillDisplayMetadata({
      installedSkill,
      marketplaceSkill: marketplace,
    })?.version).toBe('1.0.0');
    expect(lookupCachedSkillDisplayMetadata({
      marketplaceSkill: { id: 384, slug: 'translate-tool', name: '翻译工具' },
    })?.version).toBe('1.0.0');
  });

  it('commits metadata after manual update', () => {
    const skill = { id: '123', slug: 'office-helper', name: '办公助手' };
    const marketplace = {
      id: 123,
      slug: 'office-helper',
      name: '办公助手',
      version: '1.0.0',
      author: 'Alice',
      description: 'Office helper',
      update_time: '2026-06-01',
    };

    seedCachedSkillDisplayMetadata(skill, marketplace, marketplace);
    expect(commitCachedSkillDisplayMetadata(skill, marketplace, {
      version: '1.0.8',
      name: '翻译工具',
      author: 'Bob',
      description: 'Updated description',
      update_time: '2026-06-10',
    })).toBe(true);

    expect(lookupCachedSkillDisplayMetadata(skill, marketplace)).toEqual({
      version: '1.0.8',
      name: '翻译工具',
      author: 'Bob',
      description: 'Updated description',
      update_time: '2026-06-10',
    });
  });

  it('applies cached metadata to installed marketplace cards', () => {
    const skill = {
      id: 123,
      slug: 'translate',
      name: '翻译工具',
      description: 'live',
      version: '1.0.8',
      author: 'live author',
      update_time: '2026-06-10',
    };
    const cached = {
      version: '1.0.7',
      name: '翻译工具',
      author: 'cached author',
      description: 'cached description',
      update_time: '2026-06-01',
    };

    const display = resolveInstalledMarketplaceSkillForDisplay(skill, cached);
    expect(display.version).toBe('1.0.7');
    expect(display.author).toBe('cached author');
    expect(display.description).toBe('cached description');
    expect(display.update_time).toBe('2026-06-01');
  });

  it('purges cached metadata on uninstall', () => {
    const skill = { id: '123', slug: 'office-helper', name: '办公助手' };
    const marketplace = { id: 123, slug: 'office-helper', version: '1.0.0' };

    seedCachedSkillDisplayMetadata(skill, marketplace, marketplace);
    expect(purgeCachedSkillDisplayMetadataBySlug('office-helper')).toBe(true);
    expect(lookupCachedSkillDisplayMetadata(skill, marketplace)).toBeUndefined();
  });

  it('backfills alias keys so marketplace id and installed name share cache', () => {
    loadSkillDisplayCacheLegacy({
      翻译工具: {
        version: '1.0.7',
        name: '翻译工具',
        author: '袁益千',
        description: 'cached description',
        update_time: '2026-06-01',
      },
    }, {});

    expect(backfillSkillDisplayCacheAliases({
      installedSkill: { id: '翻译工具', slug: 'translate-tool', name: '翻译工具' },
      marketplaceSkill: { id: 456, slug: 'translate-tool', name: '翻译工具' },
    })).toBe(true);

    expect(resolveCachedSkillDisplayMetadata({
      marketplaceSkill: {
        id: 456,
        slug: 'translate-tool',
        name: '翻译工具',
        description: 'live api description',
        version: '1.0.9',
        update_time: '2026-06-10',
      },
    })?.version).toBe('1.0.7');
  });

  it('migrates legacy version-only cache entries', () => {
    loadSkillDisplayCacheLegacy({}, { '123': '1.0.5' });
    expect(lookupCachedSkillDisplayMetadata({ id: '123', slug: 'office-helper', name: '办公助手' }, { id: 123, slug: 'office-helper' })?.version).toBe('1.0.5');
  });

  it('parses display metadata for a skill from company list API payload', () => {
    const metadata = parseCompanyListSkillMetadata({
      skills: [{
        id: 384,
        name: '翻译工具',
        version: '1.13.4',
        author: '袁益干',
        skill_detail: '翻译工具，将中文翻译成英文，并返回json格式',
        update_time: '2026-06-10',
      }],
    }, '384');

    expect(metadata).toEqual({
      version: '1.13.4',
      name: '翻译工具',
      author: '袁益干',
      description: '翻译工具，将中文翻译成英文，并返回json格式',
      update_time: '2026-06-10',
    });
  });
});
