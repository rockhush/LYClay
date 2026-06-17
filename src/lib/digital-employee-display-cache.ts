import type { MarketplaceAgent } from '@/pages/DigitalEmployee/mock-data';

export type CachedDigitalEmployeeDisplayMetadata = {
  name?: string;
  description?: string;
  version?: string;
  author?: string;
  updateTime?: string;
  category?: string;
  tags?: string[];
};

export type DigitalEmployeeDisplayCacheState = {
  cachedDisplayMetadata: Record<string, CachedDigitalEmployeeDisplayMetadata>;
};

let cache: Record<string, CachedDigitalEmployeeDisplayMetadata> = {};

function normalizeSlug(slug: string | undefined): string {
  return slug?.trim() ?? '';
}

function normalizeText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function hasCachedMetadata(metadata: CachedDigitalEmployeeDisplayMetadata | undefined): boolean {
  if (!metadata) return false;
  return Boolean(
    metadata.name
    || metadata.description
    || metadata.version
    || metadata.author
    || metadata.updateTime
    || metadata.category
    || (metadata.tags && metadata.tags.length > 0),
  );
}

function metadataFromAgent(
  agent: Pick<MarketplaceAgent, 'slug' | 'name' | 'description' | 'version' | 'author' | 'updateTime' | 'category' | 'tags'>,
): CachedDigitalEmployeeDisplayMetadata {
  const metadata: CachedDigitalEmployeeDisplayMetadata = {};
  const name = normalizeText(agent.name);
  const description = normalizeText(agent.description);
  const version = normalizeText(agent.version);
  const author = normalizeText(agent.author);
  const updateTime = normalizeText(agent.updateTime);
  const category = normalizeText(agent.category);
  if (name) metadata.name = name;
  if (description) metadata.description = description;
  if (version) metadata.version = version;
  if (author) metadata.author = author;
  if (updateTime) metadata.updateTime = updateTime;
  if (category) metadata.category = category;
  if (Array.isArray(agent.tags) && agent.tags.length > 0) {
    metadata.tags = agent.tags.map((tag) => tag.trim()).filter(Boolean);
  }
  return metadata;
}

function metadataEquals(
  left: CachedDigitalEmployeeDisplayMetadata,
  right: CachedDigitalEmployeeDisplayMetadata,
): boolean {
  return left.name === right.name
    && left.description === right.description
    && left.version === right.version
    && left.author === right.author
    && left.updateTime === right.updateTime
    && left.category === right.category
    && JSON.stringify(left.tags ?? []) === JSON.stringify(right.tags ?? []);
}

export function loadDigitalEmployeeDisplayCache(
  state: DigitalEmployeeDisplayCacheState | undefined,
): void {
  cache = { ...(state?.cachedDisplayMetadata ?? {}) };
}

export function getDigitalEmployeeDisplayCacheSnapshot(): DigitalEmployeeDisplayCacheState {
  return { cachedDisplayMetadata: { ...cache } };
}

export function resolveCachedDigitalEmployeeDisplayMetadata(
  slug: string,
): CachedDigitalEmployeeDisplayMetadata | undefined {
  const key = normalizeSlug(slug);
  if (!key) return undefined;
  const metadata = cache[key];
  return metadata ? { ...metadata } : undefined;
}

export function seedCachedDigitalEmployeeDisplayMetadata(
  agents: Array<Pick<MarketplaceAgent, 'slug' | 'name' | 'description' | 'version' | 'author' | 'updateTime' | 'category' | 'tags'>>,
): boolean {
  let changed = false;
  for (const agent of agents) {
    const slug = normalizeSlug(agent.slug);
    if (!slug) continue;
    const metadata = metadataFromAgent(agent);
    if (!hasCachedMetadata(metadata)) continue;
    const existing = cache[slug];
    if (existing && metadataEquals(existing, metadata)) continue;
    cache[slug] = metadata;
    changed = true;
  }
  return changed;
}

export function buildMarketplaceAgentFromCache(slug: string): MarketplaceAgent | undefined {
  const key = normalizeSlug(slug);
  if (!key) return undefined;
  const metadata = cache[key];
  if (!hasCachedMetadata(metadata)) return undefined;
  return {
    slug: key,
    name: metadata?.name ?? '',
    description: metadata?.description ?? '',
    version: metadata?.version ?? '',
    author: metadata?.author ?? '',
    downloads: 0,
    updateTime: metadata?.updateTime ?? '',
    category: metadata?.category ?? '',
    installed: true,
    tags: metadata?.tags ?? [],
  };
}

export function resolveMarketplaceAgentWithCache(
  slug: string,
  live?: MarketplaceAgent,
): MarketplaceAgent | undefined {
  if (live) return live;
  return buildMarketplaceAgentFromCache(slug);
}

/** Test helper */
export function resetDigitalEmployeeDisplayCacheForTests(): void {
  cache = {};
}
