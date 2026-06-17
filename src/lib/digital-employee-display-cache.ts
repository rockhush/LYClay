export type CachedDigitalEmployeeDisplayMetadata = {
  version?: string;
  name?: string;
  author?: string;
  description?: string;
  updateTime?: string;
  tags?: string[];
};

export type DigitalEmployeeDisplayCacheState = {
  cachedDisplayMetadata: Record<string, CachedDigitalEmployeeDisplayMetadata>;
};

export type DigitalEmployeeMarketplaceMetadata = Pick<
  CachedDigitalEmployeeDisplayMetadata,
  'version' | 'name' | 'author' | 'description' | 'updateTime' | 'tags'
>;

let cache: Record<string, CachedDigitalEmployeeDisplayMetadata> = {};

function normalizeText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function normalizeTags(tags: string[] | undefined): string[] | undefined {
  if (!Array.isArray(tags)) return undefined;
  const normalized = tags.map((tag) => tag.trim()).filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

function hasCachedMetadata(metadata: CachedDigitalEmployeeDisplayMetadata | undefined): boolean {
  if (!metadata) return false;
  return Boolean(
    metadata.version
    || metadata.name
    || metadata.author
    || metadata.description
    || metadata.updateTime
    || (metadata.tags && metadata.tags.length > 0),
  );
}

function metadataEquals(
  left: CachedDigitalEmployeeDisplayMetadata,
  right: CachedDigitalEmployeeDisplayMetadata,
): boolean {
  return left.version === right.version
    && left.name === right.name
    && left.author === right.author
    && left.description === right.description
    && left.updateTime === right.updateTime
    && JSON.stringify(left.tags ?? []) === JSON.stringify(right.tags ?? []);
}

export function buildDigitalEmployeeDisplayCacheKeys(marketEmployeeId: string): string[] {
  const trimmed = marketEmployeeId.trim();
  return trimmed ? [trimmed] : [];
}

function metadataFromMarketplace(
  metadata: DigitalEmployeeMarketplaceMetadata,
): CachedDigitalEmployeeDisplayMetadata {
  const next: CachedDigitalEmployeeDisplayMetadata = {};
  const version = normalizeText(metadata.version);
  const name = normalizeText(metadata.name);
  const author = normalizeText(metadata.author);
  const description = normalizeText(metadata.description);
  const updateTime = normalizeText(metadata.updateTime);
  const tags = normalizeTags(metadata.tags);
  if (version) next.version = version;
  if (name) next.name = name;
  if (author) next.author = author;
  if (description) next.description = description;
  if (updateTime) next.updateTime = updateTime;
  if (tags) next.tags = tags;
  return next;
}

export function loadDigitalEmployeeDisplayCache(state: DigitalEmployeeDisplayCacheState | undefined): void {
  cache = { ...(state?.cachedDisplayMetadata ?? {}) };
}

export function getDigitalEmployeeDisplayCacheSnapshot(): DigitalEmployeeDisplayCacheState {
  return { cachedDisplayMetadata: { ...cache } };
}

export function resolveCachedDigitalEmployeeDisplayMetadata(
  marketEmployeeId: string,
): CachedDigitalEmployeeDisplayMetadata | undefined {
  const keys = buildDigitalEmployeeDisplayCacheKeys(marketEmployeeId);
  for (const key of keys) {
    const entry = cache[key];
    if (hasCachedMetadata(entry)) return { ...entry };
  }
  return undefined;
}

function writeCachedMetadataForKeys(
  keys: string[],
  metadata: CachedDigitalEmployeeDisplayMetadata,
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

/** One-time seed from API when no cached metadata exists yet. */
export function seedCachedDigitalEmployeeDisplayMetadata(
  marketEmployeeId: string,
  apiMetadata?: DigitalEmployeeMarketplaceMetadata,
): boolean {
  const keys = buildDigitalEmployeeDisplayCacheKeys(marketEmployeeId);
  if (keys.length === 0) return false;

  const existing = resolveCachedDigitalEmployeeDisplayMetadata(marketEmployeeId);
  if (existing) return false;

  const metadata = metadataFromMarketplace(apiMetadata ?? {});
  if (!hasCachedMetadata(metadata)) return false;
  return writeCachedMetadataForKeys(keys, metadata);
}

/** Force-sync cached metadata after a successful install or manual update. */
export function commitCachedDigitalEmployeeDisplayMetadata(
  marketEmployeeId: string,
  apiMetadata?: DigitalEmployeeMarketplaceMetadata,
): boolean {
  const keys = buildDigitalEmployeeDisplayCacheKeys(marketEmployeeId);
  if (keys.length === 0) return false;

  const metadata = metadataFromMarketplace(apiMetadata ?? {});
  if (!hasCachedMetadata(metadata)) return false;
  return writeCachedMetadataForKeys(keys, metadata);
}

export function purgeCachedDigitalEmployeeDisplayMetadata(marketEmployeeId: string): boolean {
  const keys = buildDigitalEmployeeDisplayCacheKeys(marketEmployeeId);
  let changed = false;
  for (const key of keys) {
    if (key in cache) {
      delete cache[key];
      changed = true;
    }
  }
  return changed;
}

export function resolveInstalledDigitalEmployeeForDisplay(
  marketEmployeeId: string,
  marketplace?: DigitalEmployeeMarketplaceMetadata,
  cached?: CachedDigitalEmployeeDisplayMetadata,
): DigitalEmployeeMarketplaceMetadata {
  const resolvedCache = cached ?? resolveCachedDigitalEmployeeDisplayMetadata(marketEmployeeId);
  return {
    version: marketplace?.version?.trim() || resolvedCache?.version || '',
    name: marketplace?.name?.trim() || resolvedCache?.name || '',
    author: marketplace?.author?.trim() || resolvedCache?.author || '',
    description: marketplace?.description?.trim() || resolvedCache?.description || '',
    updateTime: marketplace?.updateTime?.trim() || resolvedCache?.updateTime || '',
    tags: marketplace?.tags ?? resolvedCache?.tags ?? [],
  };
}
