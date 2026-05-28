import * as fs from 'fs';
import * as path from 'path';
import { getOpenClawConfigDir } from './paths';
import {
  COMPANY_MARKETPLACE_SIDECAR,
  fetchCompanyMarketplaceSkills,
  readCompanyMarketplaceInstallRegistry,
  resolveCompanyMarketplacePackageSlug,
} from './company-marketplace-installs';
import { getPreservedSkillDirectory } from './skill-workspace-preserve';

const COMPANY_API_BASE = 'http://portal.srv.lstech.com/aihome/api/skill';

export interface SkillCheckUpdateResult {
  skill_id: number;
  skill_name?: string;
  current_version: string;
  has_update: boolean;
  latest_version?: string;
  error?: string;
}

async function removeDirectoryIfExists(targetDir: string): Promise<void> {
  if (!fs.existsSync(targetDir)) return;
  await fs.promises.rm(targetDir, { recursive: true, force: true });
}

/** Remove live and preserved skill directories so a reinstall fetches fresh content. */
export async function purgeSkillInstallDirectories(...slugs: string[]): Promise<void> {
  const uniqueSlugs = [...new Set(slugs.map((slug) => slug.trim()).filter(Boolean))];
  for (const slug of uniqueSlugs) {
    const skillDir = path.join(getOpenClawConfigDir(), 'skills', slug);
    if (fs.existsSync(skillDir)) {
      console.log('[CompanySkillUpdate] Removing skills directory:', skillDir);
    }
    await removeDirectoryIfExists(skillDir);
    const preservedDir = getPreservedSkillDirectory(slug);
    if (fs.existsSync(preservedDir)) {
      console.log('[CompanySkillUpdate] Removing preserved directory:', preservedDir);
    }
    await removeDirectoryIfExists(preservedDir);
  }
}

function readSidecarMarketplaceId(skillDir: string): string | undefined {
  try {
    const raw = fs.readFileSync(path.join(skillDir, COMPANY_MARKETPLACE_SIDECAR), 'utf8');
    const parsed = JSON.parse(raw) as { marketplaceId?: number | string };
    return parsed.marketplaceId != null ? String(parsed.marketplaceId).trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Remove every on-disk install tied to a marketplace id before a fresh download.
 * Scans ~/.openclaw/skills and preserved backups by folder name and sidecar id.
 */
export async function purgeCompanySkillForFreshInstall(
  marketplaceIdOrSlug: string,
): Promise<string | undefined> {
  const installKey = marketplaceIdOrSlug.trim();
  if (!installKey) return undefined;

  const packageSlug = await resolveCompanyMarketplacePackageSlug(installKey);
  const slugsToPurge = new Set<string>([installKey]);
  if (packageSlug) slugsToPurge.add(packageSlug);

  const skillsRoot = path.join(getOpenClawConfigDir(), 'skills');
  if (fs.existsSync(skillsRoot)) {
    for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const folderName = entry.name;
      const skillDir = path.join(skillsRoot, folderName);
      const sidecarMarketplaceId = readSidecarMarketplaceId(skillDir);
      if (sidecarMarketplaceId === installKey || folderName === packageSlug) {
        slugsToPurge.add(folderName);
      }
    }
  }

  const preservedRoot = path.join(getOpenClawConfigDir(), '.lyclaw', 'preserved-skills');
  if (fs.existsSync(preservedRoot)) {
    for (const entry of fs.readdirSync(preservedRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const preservedDir = path.join(preservedRoot, entry.name);
      const sidecarMarketplaceId = readSidecarMarketplaceId(preservedDir);
      if (sidecarMarketplaceId === installKey || entry.name === packageSlug) {
        slugsToPurge.add(entry.name);
      }
    }
  }

  console.log('[CompanySkillUpdate] Purging for fresh install:', [...slugsToPurge]);
  await purgeSkillInstallDirectories(...slugsToPurge);
  return packageSlug;
}

export function logSkillCheckUpdateResultsSummary(results: SkillCheckUpdateResult[]): void {
  console.log('[CompanySkillUpdate] ========== 检查更新汇总 ==========');
  for (const item of results) {
    const label = item.skill_name?.trim() || `skill_id=${item.skill_id}`;
    if (item.error) {
      console.log(`[CompanySkillUpdate] // ${label}: 检测失败 — ${item.error}`);
      continue;
    }
    if (item.has_update) {
      console.log(
        `[CompanySkillUpdate] // ${label}: 当前 v${item.current_version} → 最新 v${item.latest_version ?? '?'}（有更新）`,
      );
      continue;
    }
    console.log(`[CompanySkillUpdate] // ${label}: 当前 v${item.current_version}（已是最新）`);
  }
  console.log('[CompanySkillUpdate] ====================================');
}

export async function checkCompanySkillUpdate(
  skillId: number | string,
  currentVersion: string,
  options?: { skillName?: string },
): Promise<SkillCheckUpdateResult> {
  const id = Number(skillId);
  const version = currentVersion.trim();
  const displayName = options?.skillName?.trim() || `skill_id=${id}`;
  const params = new URLSearchParams({
    skill_id: String(id),
    current_version: version,
  });
  const url = `${COMPANY_API_BASE}/check_update/?${params.toString()}`;
  console.log(`[CompanySkillUpdate] 开始检测 · ${displayName}:`, { skill_id: id, current_version: version, url });

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`Company API error: ${response.status}`);
    }

    const data = await response.json() as {
      has_update?: boolean;
      latest_version?: string;
      skill_name?: string;
      skill_id?: number;
    };
    console.log(`[CompanySkillUpdate] API 原始返回 · ${displayName}:`, data);

    const result: SkillCheckUpdateResult = {
      skill_id: data.skill_id ?? id,
      skill_name: data.skill_name?.trim() || options?.skillName?.trim(),
      current_version: version,
      has_update: Boolean(data.has_update),
      latest_version: data.latest_version?.trim() || undefined,
    };
    console.log(`[CompanySkillUpdate] 解析结果 · ${result.skill_name ?? displayName}:`, result);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[CompanySkillUpdate] 检测异常 · ${displayName}:`, message);
    return {
      skill_id: id,
      skill_name: options?.skillName?.trim(),
      current_version: version,
      has_update: false,
      error: message,
    };
  }
}

export async function checkInstalledCompanySkillUpdates(): Promise<SkillCheckUpdateResult[]> {
  const registry = await readCompanyMarketplaceInstallRegistry();
  const installedIds = Object.keys(registry.byMarketplaceId);
  if (installedIds.length === 0) return [];

  const apiSkills = await fetchCompanyMarketplaceSkills();
  const apiById = new Map(apiSkills.map((skill) => [String(skill.id), skill]));

  const checks = installedIds.map(async (marketplaceId) => {
    const entry = registry.byMarketplaceId[marketplaceId];
    const apiSkill = apiById.get(marketplaceId);
    const currentVersion = (apiSkill?.version || entry.version || '').trim();
    if (!currentVersion) {
      return {
        skill_id: Number(marketplaceId) || 0,
        skill_name: entry.name || apiSkill?.name,
        current_version: '',
        has_update: false,
        error: 'Missing current version',
      } satisfies SkillCheckUpdateResult;
    }

    return checkCompanySkillUpdate(marketplaceId, currentVersion, {
      skillName: entry.name || apiSkill?.name,
    });
  });

  return Promise.all(checks);
}
