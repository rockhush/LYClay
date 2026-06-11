import * as fs from 'fs';
import * as path from 'path';
import { getOpenClawConfigDir } from './paths';
import {
  COMPANY_MARKETPLACE_SIDECAR,
  fetchCompanyMarketplaceSkills,
  readCompanyMarketplaceInstallRegistry,
  resolveCompanyMarketplacePackageSlug,
} from './company-marketplace-installs';
import { readSkillManifestVersionFromDir, normalizeSkillMdVersionForUpdateCheck } from './company-skill-package';
import { getPreservedSkillDirectory } from './skill-workspace-preserve';

const COMPANY_API_BASE = 'http://portal.srv.lstech.com/aihome/api/skill';

/** 设为 marketplace skill_id 时，仅打印该技能的检查更新入参/返回。 */
const CHECK_UPDATE_DEBUG_SKILL_ID: number | null = 398; // 合同智能核验助手

function logCheckUpdateTrace(
  skillId: number | string,
  phase: '入参' | '返回',
  payload: Record<string, unknown>,
): void {
  if (CHECK_UPDATE_DEBUG_SKILL_ID == null || Number(skillId) !== CHECK_UPDATE_DEBUG_SKILL_ID) return;
  console.log(`[检查更新] skill_id=${skillId} ${phase}:`, payload);
}

export interface SkillCheckUpdateResult {
  skill_id: number;
  skill_name?: string;
  current_version: string;
  has_update: boolean;
  latest_version?: string;
  error?: string;
  upstream_url?: string;
  upstream_status?: number;
}

/** Public check-update payload returned to renderer. */
export interface SkillCheckUpdatePublicResult {
  skill_id: number;
  skill_name: string;
  has_update: boolean;
  latest_version: string;
}

export function toPublicCheckUpdateResult(result: SkillCheckUpdateResult): SkillCheckUpdatePublicResult {
  return {
    skill_id: result.skill_id,
    skill_name: result.skill_name?.trim() || '',
    has_update: result.has_update,
    latest_version: result.latest_version?.trim() || '',
  };
}

export function toHostCheckUpdateResult(result: SkillCheckUpdateResult) {
  return {
    ...toPublicCheckUpdateResult(result),
    current_version: result.current_version,
    ...(result.upstream_url ? { upstream_url: result.upstream_url } : {}),
    ...(result.upstream_status != null ? { upstream_status: result.upstream_status } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
}

type CompanyCheckUpdatePayload = {
  has_update?: boolean;
  latest_version?: string;
  skill_name?: string;
  skill_id?: number;
};

export function unwrapCompanyCheckUpdatePayload(raw: unknown): CompanyCheckUpdatePayload {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid company API response');
  }

  const record = raw as CompanyCheckUpdatePayload & {
    success?: boolean;
    data?: CompanyCheckUpdatePayload;
    message?: string;
  };

  if (record.data && typeof record.data === 'object') {
    return record.data;
  }

  return record;
}

/** Compare local current_version with API latest_version; any mismatch means updatable. */
export function resolveSkillHasUpdate(
  currentVersion: string | undefined,
  latestVersion: string | undefined,
): boolean {
  const current = normalizeSkillMdVersionForUpdateCheck(currentVersion);
  const latest = normalizeSkillMdVersionForUpdateCheck(latestVersion);
  if (!latest) return false;
  return current !== latest;
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

function resolveInstalledSkillMdVersion(packageSlug: string | undefined): string {
  if (!packageSlug?.trim()) return '';
  const skillDir = path.join(getOpenClawConfigDir(), 'skills', packageSlug.trim());
  return normalizeSkillMdVersionForUpdateCheck(readSkillManifestVersionFromDir(skillDir));
}

export async function checkCompanySkillUpdateForInstalled(
  skillId: number | string,
  options?: { skillName?: string; currentVersion?: string },
): Promise<SkillCheckUpdateResult> {
  const marketplaceId = String(skillId).trim();
  const packageSlug = await resolveCompanyMarketplacePackageSlug(marketplaceId);
  const registry = await readCompanyMarketplaceInstallRegistry();
  const registryEntry = registry.byMarketplaceId[marketplaceId];
  const resolvedSkillName = options?.skillName?.trim() || registryEntry?.name?.trim() || '';
  const skillMdVersion = options?.currentVersion?.trim()
    ? normalizeSkillMdVersionForUpdateCheck(options.currentVersion)
    : resolveInstalledSkillMdVersion(packageSlug);

  logCheckUpdateTrace(marketplaceId, '入参', {
    skill_id: Number(marketplaceId),
    current_version: skillMdVersion,
    current_version_source: options?.currentVersion?.trim() ? 'override' : 'skill_md',
  });

  const result = await checkCompanySkillUpdate(skillId, skillMdVersion, {
    skillName: resolvedSkillName || undefined,
  });

  if (!result.skill_name?.trim() && resolvedSkillName) {
    result.skill_name = resolvedSkillName;
  }

  return result;
}

export async function checkCompanySkillUpdate(
  skillId: number | string,
  currentVersion: string,
  options?: { skillName?: string },
): Promise<SkillCheckUpdateResult> {
  const id = Number(skillId);
  const version = normalizeSkillMdVersionForUpdateCheck(currentVersion);
  const params = new URLSearchParams({
    skill_id: String(id),
    current_version: version,
  });
  const url = `${COMPANY_API_BASE}/check_update/?${params.toString()}`;

  try {
    if (CHECK_UPDATE_DEBUG_SKILL_ID != null && Number(skillId) === CHECK_UPDATE_DEBUG_SKILL_ID) {
      console.log(`[检查更新] skill_id=${CHECK_UPDATE_DEBUG_SKILL_ID} 公司 API 请求:`, {
        url,
        method: 'GET',
        params: {
          skill_id: id,
          current_version: version,
        },
      });
    }

    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`Company API error: ${response.status}`);
    }

    const raw = await response.json();
    const data = unwrapCompanyCheckUpdatePayload(raw);

    const latestVersion = data.latest_version?.trim() || undefined;
    const hasUpdate = typeof data.has_update === 'boolean'
      ? data.has_update
      : resolveSkillHasUpdate(version, latestVersion);

    if (CHECK_UPDATE_DEBUG_SKILL_ID != null && Number(skillId) === CHECK_UPDATE_DEBUG_SKILL_ID) {
      console.log(`[检查更新] skill_id=${CHECK_UPDATE_DEBUG_SKILL_ID} 公司 API 完整响应:`, {
        url,
        status: response.status,
        raw_body: raw,
        parsed: data,
        has_update_from_api: Boolean(data.has_update),
        has_update_resolved: hasUpdate,
      });
    }

    const result: SkillCheckUpdateResult = {
      skill_id: data.skill_id ?? id,
      skill_name: data.skill_name?.trim() || options?.skillName?.trim(),
      current_version: version,
      has_update: hasUpdate,
      latest_version: latestVersion,
      upstream_url: url,
      upstream_status: response.status,
    };
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      skill_id: id,
      skill_name: options?.skillName?.trim(),
      current_version: version,
      has_update: false,
      upstream_url: url,
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
    return checkCompanySkillUpdateForInstalled(marketplaceId, {
      skillName: entry.name || apiSkill?.name,
    });
  });

  return Promise.all(checks);
}
