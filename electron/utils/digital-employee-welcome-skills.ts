import { access, readFile, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import type {
  DigitalEmployeeInstallRecord,
  DigitalEmployeeWelcomeSkill,
} from '../../shared/types/digital-employee';
import { parseSkillManifestFields } from './company-skill-package';

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readSkillDisplayName(skillDir: string, fallbackSlug: string): Promise<string> {
  for (const fileName of ['SKILL.md', 'skill.md']) {
    const manifestPath = join(skillDir, fileName);
    if (!(await pathExists(manifestPath))) continue;
    try {
      const raw = await readFile(manifestPath, 'utf8');
      const name = parseSkillManifestFields(raw).name?.trim();
      if (name) return name;
    } catch {
      // try next candidate
    }
  }
  return fallbackSlug;
}

function resolvePackagedSkillDir(
  installPath: string,
  packaged: { slug: string; path?: string },
): string {
  const relativePath = packaged.path?.trim();
  if (relativePath) {
    return resolve(installPath, relativePath.replace(/^\.?\//, ''));
  }
  return join(installPath, 'skills', packaged.slug);
}

async function scanSkillsDirectory(skillsRoot: string): Promise<string[]> {
  if (!(await pathExists(skillsRoot))) return [];
  const entries = await readdir(skillsRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, 'en'));
}

async function buildWelcomeSkill(
  skillDir: string,
  slug: string,
): Promise<DigitalEmployeeWelcomeSkill | null> {
  if (!(await pathExists(skillDir))) return null;
  const name = await readSkillDisplayName(skillDir, slug);
  return {
    slug,
    name,
    baseDir: skillDir,
  };
}

/** Resolve welcome-page skills from install metadata and on-disk SKILL.md files. */
export async function listDigitalEmployeeWelcomeSkills(
  record: Pick<DigitalEmployeeInstallRecord, 'installPath' | 'packagedSkills'>,
): Promise<DigitalEmployeeWelcomeSkill[]> {
  const installPath = record.installPath.trim();
  if (!installPath) return [];

  const packaged = Array.isArray(record.packagedSkills) ? record.packagedSkills : [];
  const slugEntries = packaged.length > 0
    ? packaged.map((entry) => ({ slug: entry.slug.trim(), path: entry.path }))
    : (await scanSkillsDirectory(join(installPath, 'skills'))).map((slug) => ({ slug, path: undefined }));

  const welcomeSkills: DigitalEmployeeWelcomeSkill[] = [];
  for (const entry of slugEntries) {
    const slug = entry.slug.trim();
    if (!slug) continue;
    const skillDir = resolvePackagedSkillDir(installPath, entry);
    const welcomeSkill = await buildWelcomeSkill(skillDir, slug);
    if (welcomeSkill) welcomeSkills.push(welcomeSkill);
  }

  return welcomeSkills.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
}
