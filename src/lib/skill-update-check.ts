/**
 * Startup / background skill update detection (check-only, no install).
 * Mirrors batch-update "select all" resolution and per-skill check-updates calls.
 */
import { hostApiFetch } from '@/lib/host-api';
import { resolveCachedSkillDisplayMetadata } from '@/lib/skill-display-cache';
import {
  companyInstallEntriesToMarketplaceSkills,
  dedupeInstalledMarketplaceSkillsForBatchUpdate,
  isMarketplaceSkillInstalledOnDisk,
  normalizeMarketplaceSkillForUpdate,
  resolveCompanyMarketplaceUpdateSlug,
} from '@/lib/skill-metadata';
import { resolveInstalledVersionForMarketplaceSkill } from '@/lib/skill-update-verification';
import { isNewSkillByCreateTime } from '@/lib/skill-marketplace-time';
import { useSkillsStore } from '@/stores/skills';
import type { MarketplaceSkill, Skill } from '@/types/skill';

export type UpdatableSkillInfo = {
  slug: string;
  name: string;
  latestVersion: string;
};

export type NewSkillInfo = {
  slug: string;
  name: string;
};

export type SkillUpdateCheckResult =
  | { status: 'updatable'; latestVersion: string; marketplaceId: string }
  | { status: 'skipped'; latestVersion: string }
  | { status: 'failed'; error?: string };

export function resolveMarketplaceSkillBySlug(slug: string): MarketplaceSkill | undefined {
  const { searchResults, companyInstallEntries, companyInstallByPackageSlug } = useSkillsStore.getState();
  const fromSearch = searchResults.find(
    (item) => item.slug === slug || String(item.id) === slug,
  );
  if (fromSearch) return fromSearch;

  if (/^\d+$/.test(slug)) {
    const entry = companyInstallEntries[slug];
    if (entry) {
      return companyInstallEntriesToMarketplaceSkills({ [slug]: entry })[0];
    }
  }

  const sidecarEntry = companyInstallByPackageSlug[slug];
  if (sidecarEntry?.marketplaceId) {
    const marketplaceId = sidecarEntry.marketplaceId;
    const fromSearchBySidecar = searchResults.find((item) => String(item.id) === marketplaceId);
    if (fromSearchBySidecar) return fromSearchBySidecar;
    return companyInstallEntriesToMarketplaceSkills({
      [marketplaceId]: {
        packageSlug: sidecarEntry.packageSlug,
        name: sidecarEntry.name,
        version: sidecarEntry.version,
        author: sidecarEntry.author,
        description: sidecarEntry.description,
      },
    })[0];
  }

  for (const [marketplaceId, entry] of Object.entries(companyInstallEntries)) {
    if (entry.packageSlug === slug) {
      const fromSearchByPackage = searchResults.find(
        (item) => String(item.id) === marketplaceId,
      );
      if (fromSearchByPackage) return fromSearchByPackage;
      return companyInstallEntriesToMarketplaceSkills({ [marketplaceId]: entry })[0];
    }
  }

  return undefined;
}

export function resolveSkillUpdateTarget(skill: MarketplaceSkill): {
  updateSlug: string;
  marketplaceSkill: MarketplaceSkill;
} | null {
  const {
    companyInstallMap,
    companyInstallByPackageSlug,
    searchResults: plazaResults,
  } = useSkillsStore.getState();
  const normalized = normalizeMarketplaceSkillForUpdate(
    skill,
    companyInstallMap,
    companyInstallByPackageSlug,
    plazaResults,
  );
  const updateSlug = resolveCompanyMarketplaceUpdateSlug(
    normalized,
    companyInstallMap,
    companyInstallByPackageSlug,
    plazaResults,
  );
  if (!updateSlug) return null;

  const marketplaceSkill = resolveMarketplaceSkillBySlug(updateSlug) ?? normalized;
  return { updateSlug, marketplaceSkill };
}

export function buildInstalledSkillsForBatchUpdate(input: {
  searchResults: MarketplaceSkill[];
  companyInstallEntries: Record<string, { packageSlug: string; name: string; version: string; author?: string; description?: string }>;
  companyInstallMap: Record<string, string>;
  companyInstallByPackageSlug: Record<string, { packageSlug: string; name: string; version: string; author?: string; description?: string; marketplaceId: string }>;
  skills: Skill[];
}): MarketplaceSkill[] {
  const merged = [
    ...input.searchResults,
    ...companyInstallEntriesToMarketplaceSkills(input.companyInstallEntries),
  ];
  return dedupeInstalledMarketplaceSkillsForBatchUpdate(
    merged,
    input.companyInstallMap,
    input.companyInstallByPackageSlug,
    input.searchResults,
  ).filter((skill) => isMarketplaceSkillInstalledOnDisk(skill, input.skills, input.companyInstallMap));
}

export async function prepareSkillUpdateCheck(): Promise<void> {
  try {
    const initial = useSkillsStore.getState();
    if (!initial.marketplaceCatalogLoaded && initial.searchResults.length === 0) {
      await initial.searchSkills('', '', '-download_count');
    }

    const current = useSkillsStore.getState();
    const hasCompanyInstallState = Object.keys(current.companyInstallMap).length > 0
      || Object.keys(current.companyInstallEntries).length > 0
      || Object.keys(current.companyInstallByPackageSlug).length > 0;
    if (!hasCompanyInstallState) {
      const installMapResponse = await hostApiFetch<{
        success: boolean;
        installs?: Record<string, string>;
        entries?: Record<string, {
          packageSlug: string;
          name: string;
          version: string;
          author?: string;
          description?: string;
        }>;
        byPackageSlug?: Record<string, {
          packageSlug: string;
          name: string;
          version: string;
          author?: string;
          description?: string;
          marketplaceId: string;
        }>;
      }>('/api/clawhub/company-install-map');
      if (installMapResponse.success) {
        const latest = useSkillsStore.getState();
        useSkillsStore.setState({
          companyInstallMap: installMapResponse.installs ?? latest.companyInstallMap,
          companyInstallEntries: installMapResponse.entries ?? latest.companyInstallEntries,
          companyInstallByPackageSlug: installMapResponse.byPackageSlug
            ?? latest.companyInstallByPackageSlug,
        });
      }
    }
  } catch (error) {
    console.warn('[SkillUpdateCheck] Catalog refresh failed (continuing):', error);
  }
}

export async function checkSkillUpdateForMarketplace(
  skill: MarketplaceSkill,
  context?: {
    skills: Skill[];
    companyInstallMap: Record<string, string>;
    companyInstallEntries: Record<string, { packageSlug: string; name: string; version: string }>;
  },
): Promise<SkillUpdateCheckResult> {
  const state = context ?? useSkillsStore.getState();
  const marketplaceId = skill.id != null ? String(skill.id).trim() : '';
  if (!marketplaceId || !/^\d+$/.test(marketplaceId)) {
    return { status: 'failed' };
  }

  const installedVersion = resolveInstalledVersionForMarketplaceSkill(
    skill,
    state.skills,
    state.companyInstallMap,
    state.companyInstallEntries,
  );

  const params = new URLSearchParams({ skill_ids: marketplaceId });
  if (installedVersion) {
    params.set('current_version', installedVersion);
  }

  try {
    const check = await hostApiFetch<{
      success: boolean;
      error?: string;
      results?: Array<{
        skill_id: number;
        has_update: boolean;
        latest_version: string;
        error?: string;
      }>;
    }>(`/api/clawhub/check-updates?${params.toString()}`);

    const item = check.results?.[0];
    const latestVersion = item?.latest_version?.trim() || '';
    if (!check.success || item?.error) {
      return { status: 'failed', error: (item?.error || check.error || '').trim() || undefined };
    }
    if (!item?.has_update) {
      return { status: 'skipped', latestVersion };
    }
    return {
      status: 'updatable',
      latestVersion,
      marketplaceId,
    };
  } catch (error) {
    console.error('[SkillUpdateCheck] check_update failed', { skill: skill.slug, error });
    return { status: 'failed' };
  }
}

function resolveSkillDisplayName(skill: MarketplaceSkill): string {
  return resolveCachedSkillDisplayMetadata({ marketplaceSkill: skill })?.name
    ?? skill.name
    ?? skill.slug
    ?? '';
}

function buildBatchUpdateTasks(selectedSkills: MarketplaceSkill[]): Array<{
  skill: MarketplaceSkill;
  target: { updateSlug: string; marketplaceSkill: MarketplaceSkill } | null;
}> {
  const seenMarketplaceIds = new Set<string>();
  return selectedSkills.flatMap((skill) => {
    const target = resolveSkillUpdateTarget(skill);
    if (!target) {
      return [{ skill, target: null as null }];
    }
    const marketplaceId = target.marketplaceSkill.id != null
      ? String(target.marketplaceSkill.id).trim()
      : '';
    if (marketplaceId && /^\d+$/.test(marketplaceId)) {
      if (seenMarketplaceIds.has(marketplaceId)) return [];
      seenMarketplaceIds.add(marketplaceId);
    }
    return [{ skill, target }];
  });
}

/** Detect updatable installed skills (same as batch update select-all, check-only). */
export async function detectUpdatableInstalledSkills(): Promise<UpdatableSkillInfo[]> {
  await prepareSkillUpdateCheck();

  const state = useSkillsStore.getState();
  const allInstalled = buildInstalledSkillsForBatchUpdate(state);
  if (allInstalled.length === 0) return [];

  const batchTasks = buildBatchUpdateTasks(allInstalled);
  const updatable: UpdatableSkillInfo[] = [];

  for (const { skill, target } of batchTasks) {
    if (!target) continue;

    const checkResult = await checkSkillUpdateForMarketplace(target.marketplaceSkill, state);
    if (checkResult.status !== 'updatable') continue;

    const name = resolveSkillDisplayName(target.marketplaceSkill)
      || resolveSkillDisplayName(skill);
    if (!name) continue;

    updatable.push({
      slug: target.updateSlug,
      name,
      latestVersion: checkResult.latestVersion,
    });
  }

  return updatable;
}

/** Detect uninstalled marketplace skills created within the last 3 days. */
export function detectNewUninstalledSkills(now = Date.now()): NewSkillInfo[] {
  const state = useSkillsStore.getState();
  const seenSlugs = new Set<string>();
  const newSkills: NewSkillInfo[] = [];

  for (const skill of state.searchResults) {
    if (isMarketplaceSkillInstalledOnDisk(skill, state.skills, state.companyInstallMap)) {
      continue;
    }
    if (!isNewSkillByCreateTime(skill.create_time, now)) {
      continue;
    }

    const slug = skill.slug?.trim();
    if (!slug || seenSlugs.has(slug)) continue;
    seenSlugs.add(slug);

    const name = resolveSkillDisplayName(skill) || skill.name || slug;
    if (!name) continue;

    newSkills.push({ slug, name });
  }

  return newSkills;
}
