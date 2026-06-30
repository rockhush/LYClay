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
  'mineru-ocr',
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

/**
 * 判断一个技能是否是从技能广场安装的
 */
export function isMarketplaceInstalledSkill(
  skill: Pick<Skill, 'id' | 'slug' | 'name' | 'baseDir' | 'downloads' | 'source'>,
  marketplaceLookup: ReturnType<typeof buildMarketplaceLookupMaps>,
): boolean {
  // 如果有 marketplace 的匹配，说明是从技能广场安装的
  const hasMarketplaceMatch = findMarketplaceSkillMatch(skill, marketplaceLookup) !== undefined;
  if (hasMarketplaceMatch) return true;
  
  // 如果有 downloads 字段，也可能是技能广场的技能
  if (skill.downloads !== undefined) return true;
  
  return false;
}

/**
 * 判断一个技能是否是自定义技能（上传或创建的，不是内置也不是技能广场的）
 */
export function isCustomSkill(
  skill: Pick<Skill, 'id' | 'slug' | 'name' | 'baseDir' | 'downloads' | 'source' | 'isBundled' | 'isCore'>,
  marketplaceLookup: ReturnType<typeof buildMarketplaceLookupMaps>,
): boolean {
  // 内置技能不是自定义技能
  if (isLyclawBuiltinSkill(skill)) return false;
  
  // 技能广场安装的不是自定义技能
  if (isMarketplaceInstalledSkill(skill, marketplaceLookup)) return false;
  
  return true;
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

/** Company plaza cards use `slug: String(skill.id)` — same key as single-skill update. */
export function isCompanyMarketplacePlazaSlug(slug: string | undefined | null): boolean {
  return isCompanyMarketplaceId(slug ?? undefined);
}

export type CompanyInstallByPackageSlug = Record<string, {
  packageSlug: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
  marketplaceId: string;
}>;

export function resolvePackageSlugForMarketplaceSkill(
  skill: Pick<MarketplaceSkill, 'id' | 'slug'>,
  companyInstallMap: Record<string, string>,
): string | undefined {
  const marketplaceId = skill.id != null ? String(skill.id).trim() : '';
  if (marketplaceId && companyInstallMap[marketplaceId]) {
    return companyInstallMap[marketplaceId];
  }

  const slug = skill.slug?.trim();
  if (slug && !isCompanyMarketplacePlazaSlug(slug)) {
    return slug;
  }
  if (slug && companyInstallMap[slug]) {
    return companyInstallMap[slug];
  }
  return slug || undefined;
}

/** Plaza listing id for an installed package folder (same source as single-skill update cards). */
export function findPlazaListingIdForPackage(
  packageSlug: string,
  companyInstallMap: Record<string, string>,
  searchResults?: MarketplaceSkill[],
): string | undefined {
  const normalizedPackage = packageSlug.trim();
  if (!normalizedPackage || !searchResults?.length) return undefined;

  for (const item of searchResults) {
    const plazaId = item.id != null ? String(item.id).trim() : '';
    if (!isCompanyMarketplaceId(plazaId)) continue;
    if (companyInstallMap[plazaId] === normalizedPackage) return plazaId;
    if (resolvePackageSlugForMarketplaceSkill(item, companyInstallMap) === normalizedPackage) {
      return plazaId;
    }
  }
  return undefined;
}

function pickAuthoritativeMarketplaceId(
  matchingIds: string[],
  options: {
    packageSlug?: string;
    companyInstallMap: Record<string, string>;
    byPackageSlug?: CompanyInstallByPackageSlug;
    searchResults?: MarketplaceSkill[];
  },
): string | undefined {
  if (matchingIds.length === 0) return undefined;
  if (matchingIds.length === 1) return matchingIds[0];

  const { packageSlug, companyInstallMap, byPackageSlug, searchResults } = options;

  if (packageSlug) {
    const sidecarId = byPackageSlug?.[packageSlug]?.marketplaceId?.trim();
    if (sidecarId && matchingIds.includes(sidecarId)) {
      return sidecarId;
    }
    const plazaId = findPlazaListingIdForPackage(packageSlug, companyInstallMap, searchResults);
    if (plazaId && matchingIds.includes(plazaId)) {
      return plazaId;
    }
  }

  return undefined;
}

/** Resolve the plaza numeric id used by single-skill update (`handleUpdate(skill.slug)`). */
export function resolveCompanyMarketplaceUpdateSlug(
  skill: MarketplaceSkill,
  companyInstallMap: Record<string, string>,
  byPackageSlug?: CompanyInstallByPackageSlug,
  searchResults?: MarketplaceSkill[],
): string | undefined {
  const packageSlug = resolvePackageSlugForMarketplaceSkill(skill, companyInstallMap);
  if (packageSlug && byPackageSlug?.[packageSlug]?.marketplaceId) {
    return byPackageSlug[packageSlug].marketplaceId;
  }

  if (packageSlug) {
    const plazaId = findPlazaListingIdForPackage(packageSlug, companyInstallMap, searchResults);
    if (plazaId) return plazaId;
  }

  if (isCompanyMarketplacePlazaSlug(skill.slug)) {
    return skill.slug!.trim();
  }

  const marketplaceId = skill.id != null ? String(skill.id).trim() : '';
  if (isCompanyMarketplaceId(marketplaceId) && companyInstallMap[marketplaceId]) {
    return marketplaceId;
  }

  if (packageSlug) {
    const matchingIds = Object.entries(companyInstallMap)
      .filter(([, slug]) => slug === packageSlug)
      .map(([id]) => id)
      .filter((id) => isCompanyMarketplaceId(id));
    if (matchingIds.length === 1) {
      return matchingIds[0];
    }
    if (matchingIds.length > 1) {
      const authoritative = pickAuthoritativeMarketplaceId(matchingIds, {
        packageSlug,
        companyInstallMap,
        byPackageSlug,
        searchResults,
      });
      if (authoritative) return authoritative;
      return undefined;
    }
  }

  return isCompanyMarketplaceId(marketplaceId) ? marketplaceId : undefined;
}

export function normalizeMarketplaceSkillForUpdate(
  skill: MarketplaceSkill,
  companyInstallMap: Record<string, string>,
  byPackageSlug?: CompanyInstallByPackageSlug,
  searchResults?: MarketplaceSkill[],
): MarketplaceSkill {
  const updateSlug = resolveCompanyMarketplaceUpdateSlug(
    skill,
    companyInstallMap,
    byPackageSlug,
    searchResults,
  );
  if (!updateSlug) return skill;
  const numericId = Number(updateSlug);
  return {
    ...skill,
    id: Number.isFinite(numericId) ? numericId : skill.id,
    slug: updateSlug,
  };
}

/** One installed package → one batch row; prefer plaza listing over registry-only rows. */
export function dedupeInstalledMarketplaceSkillsForBatchUpdate(
  skills: MarketplaceSkill[],
  companyInstallMap: Record<string, string>,
  byPackageSlug?: CompanyInstallByPackageSlug,
  searchResults?: MarketplaceSkill[],
): MarketplaceSkill[] {
  const byPackage = new Map<string, MarketplaceSkill>();
  for (const skill of skills) {
    const normalized = normalizeMarketplaceSkillForUpdate(
      skill,
      companyInstallMap,
      byPackageSlug,
      searchResults,
    );
    const packageSlug = resolvePackageSlugForMarketplaceSkill(normalized, companyInstallMap)
      || getMarketplaceSkillKey(normalized);
    const existing = byPackage.get(packageSlug);
    const incomingIsPlazaListing = isCompanyMarketplacePlazaSlug(skill.slug);
    if (!existing || incomingIsPlazaListing) {
      byPackage.set(packageSlug, normalized);
    }
  }
  return Array.from(byPackage.values());
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

/** Version label for installed cards: prefer locally cached version over live API or SKILL.md. */
export function resolveSkillListVersionForDisplay(
  skill: Pick<Skill, 'version' | 'isBundled' | 'isCore' | 'id' | 'slug' | 'name'>,
  marketplace?: Pick<MarketplaceSkill, 'version'>,
  cachedVersion?: string,
): string | undefined {
  if (isLyclawBuiltinSkill(skill)) {
    return skill.version;
  }
  const cached = cachedVersion?.trim();
  if (cached) {
    return cached;
  }
  return skill.version;
}

export function resolveSkillDisplayNameForInstalled(
  skill: Pick<Skill, 'name' | 'isBundled' | 'isCore'>,
  marketplace?: Pick<MarketplaceSkill, 'name'>,
  cachedName?: string,
): string {
  if (isLyclawBuiltinSkill(skill)) {
    return skill.name?.trim() || '';
  }
  const cached = cachedName?.trim();
  if (cached) {
    return cached;
  }
  return resolveSkillDisplayName(skill, marketplace);
}

export function resolveSkillAuthorForInstalled(
  skill: Pick<Skill, 'author'>,
  marketplace?: Pick<MarketplaceSkill, 'author'>,
  cachedAuthor?: string,
): string {
  const cached = cachedAuthor?.trim();
  if (cached) {
    return cached;
  }
  return (skill.author || marketplace?.author || '').trim();
}

/** Description for installed cards/detail: prefer locally cached metadata over live API. */
export function resolveSkillListDescriptionForDisplay(
  skill: Pick<Skill, 'description' | 'isBundled' | 'isCore' | 'id' | 'slug' | 'name'>,
  marketplace?: Pick<MarketplaceSkill, 'description'>,
  fallback = '',
  cachedDescription?: string,
): string {
  if (isLyclawBuiltinSkill(skill)) {
    return skill.description?.trim() || fallback;
  }
  const cached = cachedDescription?.trim();
  if (cached) {
    return cached;
  }
  const local = skill.description?.trim();
  if (local && !isPlaceholderSkillDescription(local)) {
    return local;
  }
  return local || fallback;
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

  if (marketplace.description?.trim() && !skill.isBundled && !skill.isCore) {
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
