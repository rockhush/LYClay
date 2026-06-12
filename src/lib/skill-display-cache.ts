import type { MarketplaceSkill, Skill } from '@/types/skill';
import { getMarketplaceSkillKey, isLyclawBuiltinSkill } from '@/lib/skill-metadata';

export type CachedSkillDisplayMetadata = {
  version?: string;
  name?: string;
  author?: string;
  description?: string;
  update_time?: string;
};

export type SkillDisplayCacheState = {
  cachedDisplayMetadata: Record<string, CachedSkillDisplayMetadata>;
};

let cache: Record<string, CachedSkillDisplayMetadata> = {};

function normalizeText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function metadataFromMarketplace(
  skill: Pick<MarketplaceSkill, 'version' | 'name' | 'author' | 'description' | 'update_time'>,
): CachedSkillDisplayMetadata {
  const metadata: CachedSkillDisplayMetadata = {};
  const version = normalizeText(skill.version);
  const name = normalizeText(skill.name);
  const author = normalizeText(skill.author);
  const description = normalizeText(skill.description);
  const updateTime = normalizeText(skill.update_time);
  if (version) metadata.version = version;
  if (name) metadata.name = name;
  if (author) metadata.author = author;
  if (description) metadata.description = description;
  if (updateTime) metadata.update_time = updateTime;
  return metadata;
}

function hasCachedMetadata(metadata: CachedSkillDisplayMetadata | undefined): boolean {
  if (!metadata) return false;
  return Boolean(
    metadata.version
    || metadata.name
    || metadata.author
    || metadata.description
    || metadata.update_time,
  );
}

function metadataEquals(
  left: CachedSkillDisplayMetadata,
  right: CachedSkillDisplayMetadata,
): boolean {
  return left.version === right.version
    && left.name === right.name
    && left.author === right.author
    && left.description === right.description
    && left.update_time === right.update_time;
}

export function loadSkillDisplayCache(state: SkillDisplayCacheState | undefined): void {
  cache = { ...(state?.cachedDisplayMetadata ?? {}) };
}

/** Backward compatibility for older ui-state payloads. */
export function loadSkillDisplayCacheLegacy(
  metadata: Record<string, CachedSkillDisplayMetadata> | undefined,
  legacyVersions: Record<string, string> | undefined,
): void {
  cache = { ...(metadata ?? {}) };
  if (!legacyVersions) return;
  for (const [key, version] of Object.entries(legacyVersions)) {
    if (!key.trim() || !version.trim()) continue;
    if (hasCachedMetadata(cache[key])) continue;
    cache[key] = { ...(cache[key] ?? {}), version: version.trim() };
  }
}

export function getSkillDisplayCacheSnapshot(): SkillDisplayCacheState {
  return { cachedDisplayMetadata: { ...cache } };
}

export function buildSkillDisplayCacheKeys(
  skill: Pick<Skill | MarketplaceSkill, 'id' | 'slug' | 'name'>,
  marketplaceMatch?: Pick<MarketplaceSkill, 'id' | 'slug'>,
): string[] {
  const keys = new Set<string>();
  const push = (value: string | number | undefined) => {
    const trimmed = value != null ? String(value).trim() : '';
    if (trimmed) keys.add(trimmed);
  };

  push(getMarketplaceSkillKey(skill));
  if (marketplaceMatch) {
    push(getMarketplaceSkillKey(marketplaceMatch));
    push(marketplaceMatch.slug);
    push(marketplaceMatch.id);
  }
  push(skill.slug);
  push(skill.id);

  return Array.from(keys);
}

export function collectSkillDisplayCacheKeys(options: {
  installedSkill?: Pick<Skill | MarketplaceSkill, 'id' | 'slug' | 'name'>;
  marketplaceSkill?: Pick<MarketplaceSkill, 'id' | 'slug' | 'name'>;
}): string[] {
  const keys = new Set<string>();
  const { installedSkill, marketplaceSkill } = options;
  const primary = installedSkill ?? marketplaceSkill;
  if (!primary) return [];

  for (const key of buildSkillDisplayCacheKeys(primary, marketplaceSkill)) {
    keys.add(key);
  }
  if (installedSkill && marketplaceSkill) {
    for (const key of buildSkillDisplayCacheKeys(installedSkill, marketplaceSkill)) {
      keys.add(key);
    }
  }
  return Array.from(keys);
}

function findMetadataAcrossKeys(keys: string[]): CachedSkillDisplayMetadata | undefined {
  const canonicalKey = keys.find((key) => /^\d+$/.test(key));
  if (canonicalKey) {
    const canonical = cache[canonicalKey];
    if (hasCachedMetadata(canonical)) return { ...canonical };
  }
  for (const key of keys) {
    const entry = cache[key];
    if (hasCachedMetadata(entry)) return { ...entry };
  }
  return undefined;
}

/** Fill missing alias keys so marketplace id and installed name share one cache entry. */
export function backfillSkillDisplayCacheAliases(options: {
  installedSkill?: Pick<Skill | MarketplaceSkill, 'id' | 'slug' | 'name'>;
  marketplaceSkill?: Pick<MarketplaceSkill, 'id' | 'slug' | 'name'>;
}): boolean {
  const keys = collectSkillDisplayCacheKeys(options);
  const existing = findMetadataAcrossKeys(keys);
  if (!existing) return false;

  let changed = false;
  for (const key of keys) {
    if (hasCachedMetadata(cache[key])) continue;
    cache[key] = { ...existing };
    changed = true;
  }
  return changed;
}

export function resolveCachedSkillDisplayMetadata(options: {
  installedSkill?: Pick<Skill, 'id' | 'slug' | 'name' | 'baseDir' | 'isBundled' | 'isCore'>;
  marketplaceSkill?: Pick<MarketplaceSkill, 'id' | 'slug' | 'name' | 'version' | 'author' | 'description' | 'update_time'>;
}): CachedSkillDisplayMetadata | undefined {
  const { installedSkill, marketplaceSkill } = options;
  const primary = installedSkill ?? marketplaceSkill;
  if (!primary) return undefined;
  if ('isBundled' in primary && isLyclawBuiltinSkill(primary)) return undefined;

  const keys = collectSkillDisplayCacheKeys({ installedSkill, marketplaceSkill });
  const metadata = findMetadataAcrossKeys(keys);
  return metadata ? { ...metadata } : undefined;
}

export function lookupCachedSkillDisplayMetadata(
  skill: Pick<Skill | MarketplaceSkill, 'id' | 'slug' | 'name' | 'isBundled' | 'isCore'>,
  marketplaceMatch?: Pick<MarketplaceSkill, 'id' | 'slug' | 'name' | 'version' | 'author' | 'description' | 'update_time'>,
): CachedSkillDisplayMetadata | undefined {
  return resolveCachedSkillDisplayMetadata({
    installedSkill: skill as Skill,
    marketplaceSkill: marketplaceMatch,
  });
}

export function lookupCachedSkillDisplayVersion(
  skill: Pick<Skill | MarketplaceSkill, 'id' | 'slug' | 'name' | 'isBundled' | 'isCore'>,
  marketplaceMatch?: Pick<MarketplaceSkill, 'id' | 'slug'>,
): string | undefined {
  return lookupCachedSkillDisplayMetadata(skill, marketplaceMatch)?.version;
}

function writeCachedMetadataForKeys(
  keys: string[],
  metadata: CachedSkillDisplayMetadata,
): boolean {
  let changed = false;
  for (const key of keys) {
    const existing = cache[key];
    if (existing && metadataEquals(existing, metadata)) continue;
    cache[key] = { ...metadata };
    changed = true;
  }
  return changed;
}

function collectWriteKeys(
  skill: Pick<Skill | MarketplaceSkill, 'id' | 'slug' | 'name'>,
  marketplaceMatch?: Pick<MarketplaceSkill, 'id' | 'slug' | 'name'>,
  installedSkill?: Pick<Skill, 'id' | 'slug' | 'name' | 'baseDir'>,
): string[] {
  return collectSkillDisplayCacheKeys({
    installedSkill: installedSkill ?? skill,
    marketplaceSkill: marketplaceMatch,
  });
}

/** One-time seed from API when no cached metadata exists yet. */
export function seedCachedSkillDisplayMetadata(
  skill: Pick<Skill | MarketplaceSkill, 'id' | 'slug' | 'name' | 'isBundled' | 'isCore'>,
  marketplaceMatch: Pick<MarketplaceSkill, 'id' | 'slug' | 'version' | 'name' | 'author' | 'description' | 'update_time'> | undefined,
  apiMetadata?: Pick<MarketplaceSkill, 'version' | 'name' | 'author' | 'description' | 'update_time'>,
  installedSkill?: Pick<Skill, 'id' | 'slug' | 'name' | 'baseDir'>,
): boolean {
  if ('isBundled' in skill && isLyclawBuiltinSkill(skill)) return false;

  const keys = collectWriteKeys(skill, marketplaceMatch, installedSkill);
  const existing = findMetadataAcrossKeys(keys);
  if (existing) {
    return backfillSkillDisplayCacheAliases({
      installedSkill: installedSkill ?? skill,
      marketplaceSkill: marketplaceMatch,
    });
  }

  const metadata = metadataFromMarketplace({
    version: apiMetadata?.version ?? marketplaceMatch?.version ?? '',
    name: apiMetadata?.name ?? marketplaceMatch?.name ?? skill.name,
    author: apiMetadata?.author ?? marketplaceMatch?.author,
    description: apiMetadata?.description ?? marketplaceMatch?.description,
    update_time: apiMetadata?.update_time ?? marketplaceMatch?.update_time,
  });
  if (!hasCachedMetadata(metadata)) return false;

  return writeCachedMetadataForKeys(keys, metadata);
}

export function parseCompanyListSkillMetadata(
  listApiResponse: unknown,
  marketplaceId: string,
): CachedSkillDisplayMetadata | undefined {
  const id = marketplaceId.trim();
  if (!id || !listApiResponse || typeof listApiResponse !== 'object') return undefined;

  const skills = (listApiResponse as { skills?: unknown }).skills;
  if (!Array.isArray(skills)) return undefined;

  const match = skills.find((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    return String((entry as { id?: number | string }).id).trim() === id;
  });
  if (!match || typeof match !== 'object') return undefined;

  const record = match as {
    name?: string;
    version?: string;
    author?: string;
    skill_detail?: string;
    update_time?: string;
  };

  const metadata: CachedSkillDisplayMetadata = {};
  const version = normalizeText(record.version);
  const name = normalizeText(record.name);
  const author = normalizeText(record.author);
  const description = normalizeText(record.skill_detail);
  const updateTime = normalizeText(record.update_time);
  if (version) metadata.version = version;
  if (name) metadata.name = name;
  if (author) metadata.author = author;
  if (description) metadata.description = description;
  if (updateTime) metadata.update_time = updateTime;
  return hasCachedMetadata(metadata) ? metadata : undefined;
}

/** Force-sync cached metadata after a successful install or manual update. */
export function commitCachedSkillDisplayMetadata(
  skill: Pick<Skill | MarketplaceSkill, 'id' | 'slug' | 'name'>,
  marketplaceMatch: Pick<MarketplaceSkill, 'id' | 'slug' | 'version' | 'name' | 'author' | 'description' | 'update_time'> | undefined,
  apiMetadata?: Pick<MarketplaceSkill, 'version' | 'name' | 'author' | 'description' | 'update_time'>,
  installedSkill?: Pick<Skill, 'id' | 'slug' | 'name' | 'baseDir'>,
): boolean {
  const metadata = metadataFromMarketplace({
    version: apiMetadata?.version ?? marketplaceMatch?.version ?? '',
    name: apiMetadata?.name ?? marketplaceMatch?.name ?? skill.name,
    author: apiMetadata?.author ?? marketplaceMatch?.author,
    description: apiMetadata?.description ?? marketplaceMatch?.description,
    update_time: apiMetadata?.update_time ?? marketplaceMatch?.update_time,
  });
  if (!hasCachedMetadata(metadata)) return false;
  return writeCachedMetadataForKeys(
    collectWriteKeys(skill, marketplaceMatch, installedSkill),
    metadata,
  );
}

export function purgeCachedSkillDisplayMetadataBySlug(slug: string): boolean {
  const trimmed = slug.trim();
  if (!trimmed) return false;
  let changed = false;
  for (const key of buildSkillDisplayCacheKeys({ id: trimmed, slug: trimmed, name: trimmed })) {
    if (key in cache) {
      delete cache[key];
      changed = true;
    }
  }
  return changed;
}

export function resolveInstalledMarketplaceSkillForDisplay(
  skill: MarketplaceSkill,
  cached?: CachedSkillDisplayMetadata,
  installedSkill?: Pick<Skill, 'name' | 'author' | 'description' | 'version'>,
): MarketplaceSkill {
  if (cached && hasCachedMetadata(cached)) {
    return {
      ...skill,
      version: cached.version ?? skill.version,
      name: cached.name ?? skill.name,
      author: cached.author ?? skill.author,
      description: cached.description ?? skill.description,
      update_time: cached.update_time ?? skill.update_time,
    };
  }
  if (installedSkill) {
    return {
      ...skill,
      name: installedSkill.name?.trim() || skill.name,
      author: installedSkill.author ?? skill.author,
      description: installedSkill.description?.trim() || skill.description,
      version: installedSkill.version ?? skill.version,
    };
  }
  return skill;
}
