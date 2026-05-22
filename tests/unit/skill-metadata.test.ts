import { describe, expect, it } from 'vitest';
import {
  buildMarketplaceLookupMaps,
  enrichSkillsWithMarketplaceMetadata,
  findMarketplaceSkillMatch,
  isPlaceholderSkillDescription,
  mergeSkillWithMarketplaceMetadata,
  normalizeSkillLookupKey,
} from '@/lib/skill-metadata';
import type { MarketplaceSkill, Skill } from '@/types/skill';

describe('skill metadata helpers', () => {
  it('normalizes lookup keys for slug/name matching', () => {
    expect(normalizeSkillLookupKey('Data-Analysis')).toBe('dataanalysis');
    expect(normalizeSkillLookupKey('Data Analysis')).toBe('dataanalysis');
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
});
