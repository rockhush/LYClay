import type { MarketplaceSkill, Skill } from '@/types/skill';

export const SKILL_INITIALIZING_DESCRIPTION = 'Recently installed, initializing...';

export function normalizeSkillLookupKey(value: string | undefined): string {
  if (!value) return '';
  return value.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

export function isPlaceholderSkillDescription(description: string | undefined): boolean {
  const trimmed = description?.trim();
  return !trimmed || trimmed === SKILL_INITIALIZING_DESCRIPTION;
}

export function isUnknownSkillVersion(version: string | undefined): boolean {
  const trimmed = version?.trim();
  return !trimmed || trimmed.toLowerCase() === 'unknown' || trimmed === '未知';
}

/** Version sent to check-update API: unknown/missing becomes empty string. */
export function normalizeSkillVersionForUpdateCheck(version: string | undefined): string {
  if (isUnknownSkillVersion(version)) return '';
  return version!.trim();
}

/** Default version label for bundled built-in skills when gateway reports unknown. */
export const BUNDLED_SKILL_DEFAULT_VERSION = '1.0.0';

/** Slugs/names treated as LYClaw built-in (aligned with skills store whitelist). */
export const LYCLAW_BUILTIN_SKILL_KEYS = new Set([
  'pdf',
  'docx',
  'docxt',
  'pptx',
  'xlsx',
  'summarize',
  'github',
  'gh-issues',
  'coding',
  'coding-agent',
  'taskflow',
  'skill-creator',
  'find-skills',
  'session-logs',
  'brave-web-search',
  'self-improving-agent',
  'healthcheck',
  'tavily-search',
  'dws',
  'lingyi-baishitong',
]);

export function isLyclawBuiltinSkill(
  skill: Pick<Skill, 'isBundled' | 'isCore' | 'id' | 'slug' | 'name'>,
): boolean {
  if (skill.isBundled || skill.isCore) return true;
  const slug = skill.slug?.trim() || '';
  const name = skill.name?.trim() || '';
  const id = skill.id?.trim() || '';
  return (
    LYCLAW_BUILTIN_SKILL_KEYS.has(id)
    || LYCLAW_BUILTIN_SKILL_KEYS.has(slug)
    || LYCLAW_BUILTIN_SKILL_KEYS.has(name)
  );
}

export function resolveSkillVersionForDisplay(
  version: string | undefined,
  options?: { treatAsBuiltin?: boolean },
): string | undefined {
  if (options?.treatAsBuiltin && isUnknownSkillVersion(version)) {
    return BUNDLED_SKILL_DEFAULT_VERSION;
  }
  return version;
}

export function shouldIncludeInMySkills(skill: Pick<Skill, 'isCore' | 'isBundled' | 'pathMissing'>): boolean {
  if (skill.isCore || skill.isBundled) return true;
  return !skill.pathMissing;
}

export type FormatSkillVersionOptions = {
  /** When true, unknown versions display as v1.0.0 (built-in tab only). */
  treatAsBuiltin?: boolean;
};

export function formatSkillVersionLabel(
  version: string | undefined,
  unknownLabel = '未知',
  options?: FormatSkillVersionOptions,
): string {
  const resolved = resolveSkillVersionForDisplay(version, options);
  if (isUnknownSkillVersion(resolved)) return unknownLabel;
  return `v${resolved!.trim()}`;
}

export function isCompanyMarketplaceId(id: string | number | undefined): boolean {
  if (id == null) return false;
  return /^\d+$/.test(String(id).trim());
}

/**
 * Whether a marketplace card should show as installed (技能广场 tab).
 * Company marketplace skills require a registry entry + on-disk folder match.
 */
export function isMarketplaceSkillInstalledOnDisk(
  skill: MarketplaceSkill,
  installedSkills: Skill[],
  companyInstallMap: Record<string, string>,
): boolean {
  if (skill.__installed === false) return false;

  const marketplaceId = skill.id != null ? String(skill.id).trim() : '';
  if (isCompanyMarketplaceId(skill.id)) {
    const packageSlug = marketplaceId ? companyInstallMap[marketplaceId] : undefined;
    if (!packageSlug) return false;
    return installedSkills.some((installed) => {
      if (installed.pathMissing) return false;
      if (installed.slug === packageSlug || installed.id === packageSlug) return true;
      if (installed.baseDir) {
        const folder = installed.baseDir.split(/[/\\]/).filter(Boolean).pop();
        if (folder === packageSlug) return true;
      }
      return false;
    });
  }

  return installedSkills.some((installed) => {
    if (installed.pathMissing) return false;
    return installed.slug === skill.slug
      || installed.id === skill.slug
      || installed.name === skill.name
      || (!!skill.slug && !!installed.baseDir && installed.baseDir.includes(skill.slug));
  });
}

/** Resolve the on-disk installed skill record for a marketplace card. */
export function findInstalledSkillForMarketplace(
  skill: MarketplaceSkill,
  installedSkills: Skill[],
  companyInstallMap: Record<string, string>,
): Skill | undefined {
  if (skill.__installed === false) return undefined;

  const marketplaceId = skill.id != null ? String(skill.id).trim() : '';
  if (isCompanyMarketplaceId(skill.id)) {
    const packageSlug = marketplaceId ? companyInstallMap[marketplaceId] : undefined;
    if (!packageSlug) return undefined;
    return installedSkills.find((installed) => {
      if (installed.pathMissing) return false;
      if (installed.slug === packageSlug || installed.id === packageSlug) return true;
      if (installed.baseDir) {
        const folder = installed.baseDir.split(/[/\\]/).filter(Boolean).pop();
        if (folder === packageSlug) return true;
      }
      return false;
    });
  }

  return installedSkills.find((installed) => {
    if (installed.pathMissing) return false;
    return installed.slug === skill.slug
      || installed.id === skill.slug
      || installed.name === skill.name
      || (!!skill.slug && !!installed.baseDir && installed.baseDir.includes(skill.slug));
  });
}

/** React list key for marketplace cards; prefers stable API id over install slug. */
export function getMarketplaceSkillKey(skill: Pick<MarketplaceSkill, 'id' | 'slug'>): string {
  if (skill.id != null && String(skill.id).trim()) {
    return String(skill.id);
  }
  return skill.slug;
}

export function buildMarketplaceLookupMaps(marketplaceSkills: MarketplaceSkill[]): {
  bySlug: Map<string, MarketplaceSkill>;
  byName: Map<string, MarketplaceSkill>;
  byNormalized: Map<string, MarketplaceSkill>;
} {
  const bySlug = new Map<string, MarketplaceSkill>();
  const byName = new Map<string, MarketplaceSkill>();
  const byNormalized = new Map<string, MarketplaceSkill>();

  for (const skill of marketplaceSkills) {
    if (skill.id != null && String(skill.id).trim()) {
      bySlug.set(String(skill.id), skill);
      const normalizedId = normalizeSkillLookupKey(String(skill.id));
      if (normalizedId) byNormalized.set(normalizedId, skill);
    }
    if (skill.slug) {
      bySlug.set(skill.slug, skill);
      const normalizedSlug = normalizeSkillLookupKey(skill.slug);
      if (normalizedSlug) byNormalized.set(normalizedSlug, skill);
    }
    if (skill.name) {
      byName.set(skill.name, skill);
      const normalizedName = normalizeSkillLookupKey(skill.name);
      if (normalizedName) byNormalized.set(normalizedName, skill);
    }
  }

  return { bySlug, byName, byNormalized };
}

export function companyInstallEntriesToMarketplaceSkills(
  entries: Record<string, { packageSlug: string; name: string; version: string; author?: string; description?: string }>,
): MarketplaceSkill[] {
  return Object.entries(entries).map(([marketplaceId, entry]) => ({
    id: Number(marketplaceId) || marketplaceId,
    slug: entry.packageSlug,
    name: entry.name,
    description: entry.description || '',
    version: entry.version,
    author: entry.author,
  }));
}

export function findMarketplaceSkillMatch(
  skill: Pick<Skill, 'id' | 'slug' | 'name' | 'baseDir'>,
  lookup: ReturnType<typeof buildMarketplaceLookupMaps>,
): MarketplaceSkill | undefined {
  const candidates = [skill.slug, skill.id, skill.name].filter(
    (value): value is string => Boolean(value && value.trim()),
  );

  for (const candidate of candidates) {
    const direct = lookup.bySlug.get(candidate) || lookup.byName.get(candidate);
    if (direct) return direct;
    const normalized = normalizeSkillLookupKey(candidate);
    if (normalized) {
      const matched = lookup.byNormalized.get(normalized);
      if (matched) return matched;
    }
  }

  if (skill.baseDir?.trim()) {
    const segments = skill.baseDir.split(/[/\\]/).filter(Boolean);
    for (let index = segments.length - 1; index >= 0; index -= 1) {
      const segment = segments[index];
      const direct = lookup.bySlug.get(segment) || lookup.byName.get(segment);
      if (direct) return direct;
      const normalized = normalizeSkillLookupKey(segment);
      if (normalized) {
        const matched = lookup.byNormalized.get(normalized);
        if (matched) return matched;
      }
    }
  }

  return undefined;
}

export function resolveSkillDisplayName(
  skill: Pick<Skill, 'name' | 'isBundled' | 'isCore'>,
  marketplace?: Pick<MarketplaceSkill, 'name'>,
): string {
  if (!skill.isBundled && !skill.isCore && marketplace?.name?.trim()) {
    return marketplace.name.trim();
  }
  return skill.name?.trim() || '';
}

export function mergeSkillWithMarketplaceMetadata(
  skill: Skill,
  marketplace?: MarketplaceSkill,
): Skill {
  if (!marketplace) return skill;

  const next: Skill = { ...skill };

  if (marketplace.name?.trim() && !skill.isBundled && !skill.isCore) {
    next.name = marketplace.name.trim();
  }

  if (marketplace.description?.trim() && isPlaceholderSkillDescription(skill.description)) {
    next.description = marketplace.description.trim();
  }

  // Installed skill version comes from local SKILL.md only; never overwrite from marketplace API.

  if (marketplace.author?.trim() && !skill.author) {
    next.author = marketplace.author.trim();
  }

  if (typeof marketplace.downloads === 'number') {
    next.downloads = marketplace.downloads;
  }

  return next;
}

export function normalizeBaseDirKey(baseDir: string | undefined): string {
  if (!baseDir?.trim()) return '';
  return baseDir.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function findExistingInstalledSkill(
  skills: Skill[],
  candidate: Pick<Skill, 'id' | 'slug' | 'name' | 'baseDir'>,
): Skill | undefined {
  const baseDirKey = normalizeBaseDirKey(candidate.baseDir);
  const candidateKeys = [candidate.slug, candidate.id, candidate.name]
    .map(normalizeSkillLookupKey)
    .filter(Boolean);

  return skills.find((skill) => {
    const skillBaseDirKey = normalizeBaseDirKey(skill.baseDir);
    if (baseDirKey && skillBaseDirKey && baseDirKey === skillBaseDirKey) {
      return true;
    }
    const skillKeys = [skill.slug, skill.id, skill.name]
      .map(normalizeSkillLookupKey)
      .filter(Boolean);
    return candidateKeys.some((key) => skillKeys.includes(key));
  });
}

export function isSkillPresentOnDisk(
  skill: Pick<Skill, 'id' | 'slug' | 'name' | 'baseDir' | 'isBundled' | 'isCore'>,
  diskSkills: Array<Pick<Skill, 'id' | 'slug' | 'name' | 'baseDir'>>,
): boolean {
  if (skill.isBundled || skill.isCore) return true;
  if (diskSkills.length === 0) return false;
  return findExistingInstalledSkill(diskSkills as Skill[], skill) !== undefined;
}

function installedSkillDedupeScore(skill: Skill): number {
  let score = 0;
  if (!skill.pathMissing) score += 16;
  if (skill.description?.trim() && !isPlaceholderSkillDescription(skill.description)) score += 8;
  if (skill.icon && !['⌛', '📦', '🔧'].includes(skill.icon)) score += 4;
  if (skill.source && skill.source !== 'openclaw-managed') score += 2;
  if (!isUnknownSkillVersion(skill.version)) score += 2;
  if (skill.filePath) score += 1;
  return score;
}

function mergeInstalledSkillRecords(primary: Skill, secondary: Skill): Skill {
  return {
    ...primary,
    slug: primary.slug || secondary.slug,
    name: primary.name?.trim() ? primary.name : secondary.name,
    description: !isPlaceholderSkillDescription(primary.description)
      ? primary.description
      : secondary.description,
    version: !isUnknownSkillVersion(primary.version) ? primary.version : secondary.version,
    author: primary.author || secondary.author,
    config: { ...secondary.config, ...primary.config },
    enabled: primary.enabled,
    baseDir: primary.baseDir || secondary.baseDir,
    filePath: primary.filePath || secondary.filePath,
    pathMissing: Boolean(primary.pathMissing && secondary.pathMissing),
    source: primary.source || secondary.source,
    icon: primary.icon && primary.icon !== '⌛' ? primary.icon : secondary.icon,
  };
}

export function dedupeInstalledSkills(skills: Skill[]): Skill[] {
  const kept: Skill[] = [];
  const indexByBaseDir = new Map<string, number>();
  const indexByNormalizedKey = new Map<string, number>();

  const registerSkill = (skill: Skill, index: number) => {
    const baseDirKey = normalizeBaseDirKey(skill.baseDir);
    if (baseDirKey) indexByBaseDir.set(baseDirKey, index);
    for (const key of [skill.slug, skill.id, skill.name]) {
      const normalized = normalizeSkillLookupKey(key);
      if (normalized) indexByNormalizedKey.set(normalized, index);
    }
  };

  const findExistingIndex = (skill: Skill): number | undefined => {
    const baseDirKey = normalizeBaseDirKey(skill.baseDir);
    if (baseDirKey && indexByBaseDir.has(baseDirKey)) {
      return indexByBaseDir.get(baseDirKey);
    }
    for (const key of [skill.slug, skill.id, skill.name]) {
      const normalized = normalizeSkillLookupKey(key);
      if (normalized && indexByNormalizedKey.has(normalized)) {
        return indexByNormalizedKey.get(normalized);
      }
    }
    return undefined;
  };

  for (const skill of skills) {
    const existingIndex = findExistingIndex(skill);
    if (existingIndex !== undefined) {
      const existing = kept[existingIndex];
      const preferred =
        installedSkillDedupeScore(skill) > installedSkillDedupeScore(existing) ? skill : existing;
      const other = preferred === skill ? existing : skill;
      kept[existingIndex] = mergeInstalledSkillRecords(preferred, other);
      registerSkill(kept[existingIndex], existingIndex);
      continue;
    }

    const index = kept.length;
    kept.push(skill);
    registerSkill(skill, index);
  }

  return kept;
}

export function enrichSkillsWithMarketplaceMetadata(
  skills: Skill[],
  marketplaceSkills: MarketplaceSkill[],
): Skill[] {
  if (marketplaceSkills.length === 0) return dedupeInstalledSkills(skills);
  const lookup = buildMarketplaceLookupMaps(marketplaceSkills);
  return dedupeInstalledSkills(
    skills.map((skill) => mergeSkillWithMarketplaceMetadata(skill, findMarketplaceSkillMatch(skill, lookup))),
  );
}
