/**
 * One-time / idempotent cleanup: remove built-in skill copies from ~/.openclaw/skills
 * after they are served from openclaw/skills (bundled). Keeps company-marketplace
 * installs and user uploads (identified by sidecar or unknown slugs).
 */
import { existsSync, readdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { COMPANY_MARKETPLACE_SIDECAR } from './company-marketplace-installs';
import { BUNDLED_SKILL_SLUGS, PREINSTALLED_MARKER_NAME } from './bundled-skills-slugs';
import { getOpenClawSkillsDir } from './paths';
import { logger } from './logger';

export interface SkillHomedirMigrationResult {
  examined: number;
  removed: string[];
  kept: string[];
}

function hasMarketplaceSidecar(skillDir: string): boolean {
  return existsSync(join(skillDir, COMPANY_MARKETPLACE_SIDECAR));
}

function hasPreinstalledMarker(skillDir: string): boolean {
  return existsSync(join(skillDir, PREINSTALLED_MARKER_NAME));
}

function shouldRemoveHomedirSkillCopy(slug: string, skillDir: string): boolean {
  if (!existsSync(join(skillDir, 'SKILL.md'))) {
    return false;
  }
  if (hasMarketplaceSidecar(skillDir)) {
    return false;
  }
  if (hasPreinstalledMarker(skillDir)) {
    return true;
  }
  return BUNDLED_SKILL_SLUGS.has(slug);
}

/**
 * Remove stale built-in / preinstalled copies from the managed skills directory.
 */
export function migrateHomedirBuiltinSkills(): SkillHomedirMigrationResult {
  const skillsRoot = getOpenClawSkillsDir();
  const result: SkillHomedirMigrationResult = { examined: 0, removed: [], kept: [] };

  if (!existsSync(skillsRoot)) {
    return result;
  }

  let entries: import('fs').Dirent[];
  try {
    entries = readdirSync(skillsRoot, { withFileTypes: true });
  } catch (error) {
    logger.warn('Skill homedir migration: failed to read skills directory:', error);
    return result;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const slug = entry.name;
    const skillDir = join(skillsRoot, slug);
    result.examined += 1;

    if (!shouldRemoveHomedirSkillCopy(slug, skillDir)) {
      result.kept.push(slug);
      continue;
    }

    try {
      rmSync(skillDir, { recursive: true, force: true });
      result.removed.push(slug);
      logger.info(`Skill homedir migration: removed bundled copy ${slug} from ${skillsRoot}`);
    } catch (error) {
      logger.warn(`Skill homedir migration: failed to remove ${skillDir}:`, error);
      result.kept.push(slug);
    }
  }

  if (result.removed.length > 0) {
    logger.info(
      `Skill homedir migration complete: removed ${result.removed.length} (${result.removed.join(', ')})`,
    );
  }

  return result;
}

/** Read slugs from resources preinstalled manifest (for tests / diagnostics). */
export function readPreinstalledManifestSlugs(manifestRaw: string): string[] {
  try {
    const parsed = JSON.parse(manifestRaw) as { skills?: Array<{ slug?: string }> };
    if (!Array.isArray(parsed.skills)) return [];
    return parsed.skills.map((s) => s.slug?.trim()).filter((s): s is string => Boolean(s));
  } catch {
    return [];
  }
}

export function readPreinstalledMarkerVersion(skillDir: string): string | undefined {
  const markerPath = join(skillDir, PREINSTALLED_MARKER_NAME);
  if (!existsSync(markerPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(markerPath, 'utf8')) as { version?: string };
    return parsed.version?.trim() || undefined;
  } catch {
    return undefined;
  }
}
