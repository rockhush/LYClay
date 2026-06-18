import {
  findInstalledSkillForMarketplace,
  normalizeSkillVersionForUpdateCheck,
} from '@/lib/skill-metadata';
import type { MarketplaceSkill, Skill } from '@/types/skill';

export const SKILL_UPDATE_VERIFICATION_FAILED = 'skillUpdateVerificationFailed';

type CompanyInstallEntry = {
  packageSlug: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
};

/** Prefer on-disk SKILL.md version; fall back to install registry when disk is unknown. */
export function resolveInstalledVersionForUpdateCheck(
  installedRecord: Pick<Skill, 'version'> | undefined,
  registryVersion: string | undefined,
): string {
  const diskVersion = normalizeSkillVersionForUpdateCheck(installedRecord?.version);
  if (diskVersion) return diskVersion;
  return normalizeSkillVersionForUpdateCheck(registryVersion);
}

export function resolveInstalledVersionForMarketplaceSkill(
  skill: MarketplaceSkill,
  installedSkills: Skill[],
  companyInstallMap: Record<string, string>,
  companyInstallEntries: Record<string, CompanyInstallEntry>,
): string {
  const installedRecord = findInstalledSkillForMarketplace(skill, installedSkills, companyInstallMap);
  const marketplaceId = skill.id != null ? String(skill.id).trim() : '';
  const registryVersion = marketplaceId ? companyInstallEntries[marketplaceId]?.version : undefined;
  return resolveInstalledVersionForUpdateCheck(installedRecord, registryVersion);
}

export function hasSkillVersionMismatch(
  skill: MarketplaceSkill,
  installedSkills: Skill[],
  companyInstallMap: Record<string, string>,
  companyInstallEntries: Record<string, CompanyInstallEntry>,
  expectedLatestVersion: string | undefined,
): boolean {
  const expected = normalizeSkillVersionForUpdateCheck(expectedLatestVersion);
  if (!expected) return false;

  const installed = resolveInstalledVersionForMarketplaceSkill(
    skill,
    installedSkills,
    companyInstallMap,
    companyInstallEntries,
  );
  if (!installed) return false;
  return installed !== expected;
}
