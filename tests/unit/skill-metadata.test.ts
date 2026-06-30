import { describe, expect, it } from 'vitest';
import {
  buildMarketplaceLookupMaps,
  enrichSkillsWithMarketplaceMetadata,
  findMarketplaceSkillMatch,
  dedupeInstalledSkills,
  findExistingInstalledSkill,
  formatSkillVersionLabel,
  isLyclawBuiltinSkill,
  isPlaceholderSkillDescription,
  isSkillPresentOnDisk,
  isUnknownSkillVersion,
  normalizeSkillVersionForUpdateCheck,
  getMarketplaceSkillKey,
  isMarketplaceSkillInstalledOnDisk,
  companyInstallEntriesToMarketplaceSkills,
  dedupeInstalledMarketplaceSkillsForBatchUpdate,
  findPlazaListingIdForPackage,
  mergeSkillWithMarketplaceMetadata,
  normalizeMarketplaceSkillForUpdate,
  resolveCompanyMarketplaceUpdateSlug,
  normalizeSkillLookupKey,
  resolveSkillDisplayName,
  resolveSkillListVersionForDisplay,
  resolveSkillListDescriptionForDisplay,
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

  it('matches installed package folders to company marketplace metadata', () => {
    const lookup = buildMarketplaceLookupMaps(companyInstallEntriesToMarketplaceSkills({
      '12': {
        packageSlug: 'resume-analyzer',
        name: '候选人简历画像匹配分析',
        version: '1.0.1',
        author: '胡世炬',
      },
    }));

    const matched = findMarketplaceSkillMatch(
      {
        id: 'resume-analyzer',
        slug: 'resume-analyzer',
        name: 'resume-analyzer',
        baseDir: 'C:\\Users\\me\\.openclaw\\skills\\resume-analyzer',
      },
      lookup,
    );

    expect(matched?.name).toBe('候选人简历画像匹配分析');
    expect(matched?.version).toBe('1.0.1');
  });

  it('merges company marketplace display metadata onto installed skills', () => {
    const enriched = mergeSkillWithMarketplaceMetadata(
      {
        id: 'resume-analyzer',
        slug: 'resume-analyzer',
        name: 'resume-analyzer',
        description: '',
        enabled: true,
        version: 'unknown',
      },
      {
        id: 12,
        slug: 'resume-analyzer',
        name: '候选人简历画像匹配分析',
        description: 'Plaza description',
        version: '1.0.1',
      },
    );

    expect(enriched.name).toBe('候选人简历画像匹配分析');
    expect(enriched.version).toBe('unknown');
    expect(enriched.description).toBe('Plaza description');
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
    expect(merged.description).toBe('Translation tool');
    expect(resolveSkillDisplayName(merged, { name: 'translate' })).toBe('translate');
  });

  it('keeps bundled skill descriptions when marketplace metadata is present', () => {
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
    expect(merged.description).toBe('PDF tools');
  });

  it('prefers cached description over local SKILL.md for installed skills', () => {
    expect(
      resolveSkillListDescriptionForDisplay(
        {
          id: 'dws',
          slug: 'dws',
          name: '办公助手',
          description: 'Long YAML description from SKILL.md frontmatter...',
        },
        { description: 'Short plaza list description' },
        '',
        'Cached plaza description',
      ),
    ).toBe('Cached plaza description');
  });

  it('keeps bundled skill descriptions for display when marketplace metadata is present', () => {
    expect(
      resolveSkillListDescriptionForDisplay(
        {
          id: 'pdf',
          slug: 'pdf',
          name: 'pdf',
          description: 'PDF tools',
          isBundled: true,
        },
        { description: 'Marketplace PDF' },
      ),
    ).toBe('PDF tools');
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
    expect(merged.version).toBe('unknown');
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
    expect(enriched[0]?.version).toBe('unknown');
  });

  it('prefers cached version over local unknown version for display', () => {
    expect(
      resolveSkillListVersionForDisplay(
        {
          id: 'attendance',
          slug: 'attendance',
          name: '考勤查询',
          version: 'unknown',
        },
        { version: '1.0.6' },
        '1.0.2',
      ),
    ).toBe('1.0.2');

    expect(
      resolveSkillListVersionForDisplay(
        {
          id: 'attendance',
          slug: 'attendance',
          name: '考勤查询',
          version: 'unknown',
        },
        { version: '1.0.6' },
      ),
    ).toBe('unknown');

    expect(
      resolveSkillListVersionForDisplay(
        {
          id: 'summarize',
          slug: 'summarize',
          name: 'summarize',
          version: 'unknown',
          isBundled: true,
        },
        { version: '9.9.9' },
        '1.0.2',
      ),
    ).toBe('unknown');
  });

  it('formats unknown versions as 未知 for marketplace skills', () => {
    expect(formatSkillVersionLabel(undefined)).toBe('未知');
    expect(formatSkillVersionLabel('unknown')).toBe('未知');
    expect(formatSkillVersionLabel('')).toBe('未知');
    expect(formatSkillVersionLabel('1.0.0')).toBe('v1.0.0');
    expect(formatSkillVersionLabel('2.3.4', 'Unknown')).toBe('v2.3.4');
    expect(isUnknownSkillVersion('unknown')).toBe(true);
    expect(isUnknownSkillVersion('1.0.0')).toBe(false);
  });

  it('normalizes unknown versions to empty string for update checks', () => {
    expect(normalizeSkillVersionForUpdateCheck(undefined)).toBe('');
    expect(normalizeSkillVersionForUpdateCheck('unknown')).toBe('');
    expect(normalizeSkillVersionForUpdateCheck('未知')).toBe('');
    expect(normalizeSkillVersionForUpdateCheck('1.0.2')).toBe('1.0.2');
  });

  it('formats unknown built-in versions as v1.0.0', () => {
    const builtin = {
      id: 'summarize',
      slug: 'summarize',
      name: 'summarize',
      isBundled: true,
    } as const;
    expect(isLyclawBuiltinSkill(builtin)).toBe(true);
    expect(formatSkillVersionLabel('unknown', '未知', { treatAsBuiltin: true })).toBe('v1.0.0');
    expect(formatSkillVersionLabel(undefined, '未知', { treatAsBuiltin: true })).toBe('v1.0.0');
    expect(formatSkillVersionLabel('unknown', '未知', { treatAsBuiltin: false })).toBe('未知');
    expect(formatSkillVersionLabel('2.0.0', '未知', { treatAsBuiltin: true })).toBe('v2.0.0');
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

  it('treats company marketplace skills as uninstalled when registry entry is gone', () => {
    const marketplaceSkill: MarketplaceSkill = {
      id: 377,
      slug: '377',
      name: '前端设计工具',
      description: 'demo',
      version: '1.0.0',
    };
    const lingeringGatewaySkill: Skill = {
      id: 'frontend-design',
      slug: 'frontend-design',
      name: '前端设计工具',
      description: 'still in gateway config',
      enabled: false,
      version: '1.0.0',
      isCore: false,
      isBundled: false,
    };

    expect(
      isMarketplaceSkillInstalledOnDisk(marketplaceSkill, [lingeringGatewaySkill], {
        '377': 'frontend-design',
      }),
    ).toBe(true);

    expect(
      isMarketplaceSkillInstalledOnDisk(marketplaceSkill, [lingeringGatewaySkill], {}),
    ).toBe(false);

    expect(
      isMarketplaceSkillInstalledOnDisk(
        { ...marketplaceSkill, __installed: false },
        [lingeringGatewaySkill],
        { '377': 'frontend-design' },
      ),
    ).toBe(false);
  });

  it('resolves batch update slug from sidecar-backed package lookup', () => {
    const byPackageSlug = {
      'logistics-ai-tool': {
        packageSlug: 'logistics-ai-tool',
        name: '物流AI应用工具',
        version: '1.0.7',
        marketplaceId: '398',
      },
    };
    const registrySkill = companyInstallEntriesToMarketplaceSkills({
      '999': {
        packageSlug: 'logistics-ai-tool',
        name: '物流AI应用工具',
        version: '1.0.7',
      },
    })[0]!;

    expect(resolveCompanyMarketplaceUpdateSlug(
      registrySkill,
      { '999': 'logistics-ai-tool', '398': 'logistics-ai-tool' },
      byPackageSlug,
    )).toBe('398');

    expect(normalizeMarketplaceSkillForUpdate(
      registrySkill,
      { '999': 'logistics-ai-tool', '398': 'logistics-ai-tool' },
      byPackageSlug,
    )).toMatchObject({ id: 398, slug: '398' });
  });

  it('dedupes installed batch rows by package folder and prefers plaza listing', () => {
    const companyInstallMap = { '398': 'logistics-ai-tool', '999': 'logistics-ai-tool' };
    const byPackageSlug = {
      'logistics-ai-tool': {
        packageSlug: 'logistics-ai-tool',
        name: '物流AI应用工具',
        version: '1.0.7',
        marketplaceId: '398',
      },
    };
    const registrySkill = companyInstallEntriesToMarketplaceSkills({
      '999': {
        packageSlug: 'logistics-ai-tool',
        name: '物流AI应用工具',
        version: '1.0.7',
      },
    })[0]!;
    const plazaSkill: MarketplaceSkill = {
      id: 398,
      slug: '398',
      name: '物流AI应用工具',
      description: '',
      version: '1.0.7',
    };

    const deduped = dedupeInstalledMarketplaceSkillsForBatchUpdate(
      [registrySkill, plazaSkill],
      companyInstallMap,
      byPackageSlug,
    );

    expect(deduped).toHaveLength(1);
    expect(deduped[0]).toMatchObject({ id: 398, slug: '398' });
  });

  it('prefers plaza listing id over stale registry id when sidecar map is absent', () => {
    const registrySkill = companyInstallEntriesToMarketplaceSkills({
      '999': {
        packageSlug: 'process-scatter',
        name: '工序散点图生成器',
        version: '1.0.0',
      },
    })[0]!;
    const searchResults: MarketplaceSkill[] = [{
      id: 398,
      slug: '398',
      name: '工序散点图生成器',
      description: '',
      version: '1.0.0',
    }];

    expect(resolveCompanyMarketplaceUpdateSlug(
      registrySkill,
      { '999': 'process-scatter', '398': 'process-scatter' },
      undefined,
      searchResults,
    )).toBe('398');

    expect(findPlazaListingIdForPackage(
      'process-scatter',
      { '398': 'process-scatter' },
      searchResults,
    )).toBe('398');
  });

  it('does not guess among conflicting registry ids without sidecar or plaza match', () => {
    const registrySkill = companyInstallEntriesToMarketplaceSkills({
      '999': {
        packageSlug: 'process-scatter',
        name: '工序散点图生成器',
        version: '1.0.0',
      },
    })[0]!;

    expect(resolveCompanyMarketplaceUpdateSlug(
      registrySkill,
      { '999': 'process-scatter', '888': 'process-scatter' },
    )).toBeUndefined();
  });
});
