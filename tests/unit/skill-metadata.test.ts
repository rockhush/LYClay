import { describe, expect, it } from 'vitest';
import {
  buildMarketplaceLookupMaps,
  enrichSkillsWithMarketplaceMetadata,
  findMarketplaceSkillMatch,
  dedupeInstalledSkills,
  findExistingInstalledSkill,
  formatSkillVersionLabel,
  isPlaceholderSkillDescription,
  isSkillPresentOnDisk,
  isUnknownSkillVersion,
  getMarketplaceSkillKey,
  mergeSkillWithMarketplaceMetadata,
  normalizeSkillLookupKey,
  resolveSkillDisplayName,
  shouldIncludeInMySkills,
} from '@/lib/skill-metadata';
import type { MarketplaceSkill, Skill } from '@/types/skill';

describe('skill metadata helpers', () => {
  it('normalizes lookup keys for slug/name matching', () => {
    expect(normalizeSkillLookupKey('Data-Analysis')).toBe('dataanalysis');
    expect(normalizeSkillLookupKey('Data Analysis')).toBe('dataanalysis');
  });

  it('prefers marketplace id over slug for React list keys', () => {
    expect(getMarketplaceSkillKey({ id: 42, slug: '全网搜索' })).toBe('42');
    expect(getMarketplaceSkillKey({ slug: 'local-skill' })).toBe('local-skill');
  });

  it('matches installed skills to marketplace entries across slug variants', () => {
    const lookup = buildMarketplaceLookupMaps([
      {
        slug: 'Data-Analysis',
        name: 'Data-Analysis',
        description: 'Plaza description',
        version: '1.0.0',
      },
    ]);

    const match = findMarketplaceSkillMatch(
      { id: 'data-analysis', slug: 'data-analysis', name: 'Data Analysis' },
      lookup,
    );

    expect(match?.description).toBe('Plaza description');
    expect(match?.version).toBe('1.0.0');
  });

  it('matches installed skills to marketplace entries via baseDir segments', () => {
    const lookup = buildMarketplaceLookupMaps([
      {
        slug: 'translate',
        name: 'translate',
        description: 'Translation tool',
        version: '1.0.0',
      },
    ]);

    const match = findMarketplaceSkillMatch(
      {
        id: 'cn',
        slug: 'cn',
        name: '中文翻译成JSON',
        baseDir: 'C:\\Users\\ken.yuan\\.openclaw\\skills\\translate\\cn',
      },
      lookup,
    );

    expect(match?.name).toBe('translate');
  });

  it('prefers marketplace display name over local skill.md names', () => {
    const merged = mergeSkillWithMarketplaceMetadata(
      {
        id: 'cn',
        slug: 'cn',
        name: '中文翻译成JSON',
        description: 'Local description',
        enabled: true,
      },
      {
        slug: 'translate',
        name: 'translate',
        description: 'Translation tool',
        version: '1.0.0',
      },
    );

    expect(merged.name).toBe('translate');
    expect(resolveSkillDisplayName(merged, { name: 'translate' })).toBe('translate');
  });

  it('keeps bundled skill names when marketplace metadata is present', () => {
    const merged = mergeSkillWithMarketplaceMetadata(
      {
        id: 'pdf',
        slug: 'pdf',
        name: 'pdf',
        description: 'PDF tools',
        enabled: true,
        isBundled: true,
      },
      {
        slug: 'pdf',
        name: 'PDF Reader',
        description: 'Marketplace PDF',
        version: '1.0.0',
      },
    );

    expect(merged.name).toBe('pdf');
  });

  it('replaces placeholder descriptions with marketplace metadata', () => {
    const skill: Skill = {
      id: 'Data-Analysis',
      slug: 'Data-Analysis',
      name: 'Data-Analysis',
      description: 'Recently installed, initializing...',
      enabled: true,
      version: 'unknown',
    };
    const marketplace: MarketplaceSkill = {
      slug: 'Data-Analysis',
      name: 'Data-Analysis',
      description: '数据分析与可视化。查询数据库、生成报告...',
      version: '1.0.0',
      author: 'Kim.Su',
      downloads: 76,
    };

    const merged = mergeSkillWithMarketplaceMetadata(skill, marketplace);

    expect(isPlaceholderSkillDescription(skill.description)).toBe(true);
    expect(merged.description).toBe('数据分析与可视化。查询数据库、生成报告...');
    expect(merged.version).toBe('1.0.0');
    expect(merged.author).toBe('Kim.Su');
    expect(merged.downloads).toBe(76);
  });

  it('enriches an entire skill list from marketplace results', () => {
    const skills: Skill[] = [
      {
        id: 'test-file',
        slug: 'test-file',
        name: 'test-file',
        description: '',
        enabled: false,
        version: 'unknown',
      },
    ];
    const marketplace: MarketplaceSkill[] = [
      {
        slug: 'test-file',
        name: '测试-file',
        description: '测试技能描述',
        version: '1.0.0',
      },
    ];

    const enriched = enrichSkillsWithMarketplaceMetadata(skills, marketplace);
    expect(enriched[0]?.name).toBe('测试-file');
    expect(enriched[0]?.description).toBe('测试技能描述');
    expect(enriched[0]?.version).toBe('1.0.0');
  });

  it('formats unknown versions for display without defaulting to 1.0.0', () => {
    expect(formatSkillVersionLabel(undefined)).toBe('未知');
    expect(formatSkillVersionLabel('unknown')).toBe('未知');
    expect(formatSkillVersionLabel('')).toBe('未知');
    expect(formatSkillVersionLabel('1.0.0')).toBe('v1.0.0');
    expect(formatSkillVersionLabel('2.3.4', 'Unknown')).toBe('v2.3.4');
    expect(isUnknownSkillVersion('unknown')).toBe(true);
    expect(isUnknownSkillVersion('1.0.0')).toBe(false);
  });

  it('excludes path-missing user skills from my skills list', () => {
    expect(shouldIncludeInMySkills({ pathMissing: true })).toBe(false);
    expect(shouldIncludeInMySkills({ pathMissing: true, isBundled: true })).toBe(true);
    expect(shouldIncludeInMySkills({ pathMissing: false })).toBe(true);
  });

  it('dedupes gateway and clawhub entries for the same installed directory', () => {
    const baseDir = 'C:\\Users\\me\\.openclaw\\skills\\procurement-analyst';
    const skills: Skill[] = [
      {
        id: 'procurement-analyst',
        slug: 'procurement-analyst',
        name: 'procurement-analyst',
        description: 'Gateway description',
        enabled: true,
        icon: '📦',
        baseDir,
      },
      {
        id: '深度采购分析',
        slug: '深度采购分析',
        name: '深度采购分析',
        description: '',
        enabled: true,
        icon: '⌛',
        baseDir,
      },
    ];

    const deduped = dedupeInstalledSkills(skills);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.description).toBe('Gateway description');
    expect(deduped[0]?.baseDir).toBe(baseDir);
  });

  it('finds existing installed skills by baseDir or normalized keys', () => {
    const existing: Skill[] = [
      {
        id: 'procurement-analyst',
        slug: 'procurement-analyst',
        name: 'procurement-analyst',
        description: 'Gateway description',
        enabled: true,
        baseDir: 'C:\\Users\\me\\.openclaw\\skills\\procurement-analyst',
      },
    ];

    const match = findExistingInstalledSkill(existing, {
      id: '深度采购分析',
      slug: '深度采购分析',
      name: '深度采购分析',
      baseDir: 'C:\\Users\\me\\.openclaw\\skills\\procurement-analyst',
    });

    expect(match?.id).toBe('procurement-analyst');
  });

  it('drops gateway-only skills that are missing from the clawhub disk scan', () => {
    const diskSkills = [
      {
        id: 'coding-agent',
        slug: 'coding-agent',
        name: 'coding-agent',
        baseDir: 'C:\\Users\\me\\.openclaw\\skills\\coding-agent',
      },
    ];

    expect(
      isSkillPresentOnDisk(
        {
          id: 'China Legal Assistance Pro',
          slug: 'China Legal Assistance Pro',
          name: 'China Legal Assistance Pro',
          baseDir: 'C:\\Users\\ken.yuan\\.openclaw\\skills\\China Legal Assistance Pro',
        },
        diskSkills,
      ),
    ).toBe(false);

    expect(
      isSkillPresentOnDisk(
        {
          id: 'coding-agent',
          slug: 'coding-agent',
          name: 'coding-agent',
          baseDir: 'C:\\Users\\me\\.openclaw\\skills\\coding-agent',
        },
        diskSkills,
      ),
    ).toBe(true);

    expect(isSkillPresentOnDisk({ isBundled: true, name: 'pdf' }, [])).toBe(true);
  });
});
