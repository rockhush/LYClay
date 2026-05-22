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

export function buildMarketplaceLookupMaps(marketplaceSkills: MarketplaceSkill[]): {
  bySlug: Map<string, MarketplaceSkill>;
  byName: Map<string, MarketplaceSkill>;
  byNormalized: Map<string, MarketplaceSkill>;
} {
  const bySlug = new Map<string, MarketplaceSkill>();
  const byName = new Map<string, MarketplaceSkill>();
  const byNormalized = new Map<string, MarketplaceSkill>();

  for (const skill of marketplaceSkills) {
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

export function findMarketplaceSkillMatch(
  skill: Pick<Skill, 'id' | 'slug' | 'name'>,
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

  return undefined;
}

export function mergeSkillWithMarketplaceMetadata(
  skill: Skill,
  marketplace?: MarketplaceSkill,
): Skill {
  if (!marketplace) return skill;

  const next: Skill = { ...skill };

  if (marketplace.name?.trim()) {
    const currentName = skill.name?.trim();
    const looksLikeSlug =
      !currentName ||
      currentName === skill.slug ||
      currentName === skill.id ||
      currentName.replace(/[\s_-]+/g, '').toLowerCase() === normalizeSkillLookupKey(skill.slug || skill.id);
    if (looksLikeSlug) {
      next.name = marketplace.name;
    }
  }

  if (marketplace.description?.trim() && isPlaceholderSkillDescription(skill.description)) {
    next.description = marketplace.description.trim();
  }

  const marketplaceVersion = marketplace.version?.trim();
  if (marketplaceVersion && marketplaceVersion.toLowerCase() !== 'unknown' && !skill.isBundled) {
    next.version = marketplaceVersion;
  } else if (
    marketplaceVersion &&
    marketplaceVersion.toLowerCase() !== 'unknown' &&
    (!skill.version || skill.version.toLowerCase() === 'unknown')
  ) {
    next.version = marketplaceVersion;
  }

  if (marketplace.author?.trim() && !skill.author) {
    next.author = marketplace.author.trim();
  }

  if (typeof marketplace.downloads === 'number') {
    next.downloads = marketplace.downloads;
  }

  return next;
}

export function enrichSkillsWithMarketplaceMetadata(
  skills: Skill[],
  marketplaceSkills: MarketplaceSkill[],
): Skill[] {
  if (marketplaceSkills.length === 0) return skills;
  const lookup = buildMarketplaceLookupMaps(marketplaceSkills);
  return skills.map((skill) => mergeSkillWithMarketplaceMetadata(skill, findMarketplaceSkillMatch(skill, lookup)));
}
