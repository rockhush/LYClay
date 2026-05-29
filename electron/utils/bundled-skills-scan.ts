/**
 * Scan bundled skills from the OpenClaw package (openclaw/skills).
 * Used at startup before Gateway skills.status is ready.
 */
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { getOpenClawDir } from './paths';
import { BUNDLED_SKILL_SLUGS } from './bundled-skills-slugs';
import { readFrontmatterScalar } from './company-skill-package';

export interface BundledSkillBootstrap {
  skillKey: string;
  slug: string;
  name: string;
  description: string;
  version: string;
  author?: string;
  emoji?: string;
  bundled: true;
  disabled: false;
  source: 'openclaw-bundled';
  baseDir: string;
  filePath: string;
}

function parseSkillManifest(skillManifestPath: string): {
  name?: string;
  slug?: string;
  description?: string;
  version?: string;
  author?: string;
} {
  try {
    const raw = readFileSync(skillManifestPath, 'utf8');
    const frontmatterMatch = raw.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!frontmatterMatch) return {};

    const body = frontmatterMatch[1];

    return {
      name: readFrontmatterScalar(body, 'name'),
      slug: readFrontmatterScalar(body, 'slug'),
      description: readFrontmatterScalar(body, 'description'),
      version: readFrontmatterScalar(body, 'version'),
      author: readFrontmatterScalar(body, 'author'),
    };
  } catch {
    return {};
  }
}

function scanBundledSkillDirectories(skillsRoot: string): BundledSkillBootstrap[] {
  const results: BundledSkillBootstrap[] = [];

  let entries: import('fs').Dirent[];
  try {
    entries = readdirSync(skillsRoot, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirName = entry.name;
    const dirPath = join(skillsRoot, dirName);
    const skillManifestPath = join(dirPath, 'SKILL.md');
    if (!existsSync(skillManifestPath)) continue;

    const manifest = parseSkillManifest(skillManifestPath);
    const slug = (manifest.slug || dirName).trim();
    if (!BUNDLED_SKILL_SLUGS.has(slug) && !BUNDLED_SKILL_SLUGS.has(dirName)) {
      continue;
    }
    const skillKey = slug || dirName;

    results.push({
      skillKey,
      slug: skillKey,
      name: manifest.name || skillKey,
      description: manifest.description || '',
      version: manifest.version || 'unknown',
      author: manifest.author,
      emoji: '📦',
      bundled: true,
      disabled: false,
      source: 'openclaw-bundled',
      baseDir: dirPath,
      filePath: skillManifestPath,
    });
  }

  return results;
}

export function listBundledSkillsFromPackage(): BundledSkillBootstrap[] {
  const skillsRoot = join(getOpenClawDir(), 'skills');
  if (!existsSync(skillsRoot)) {
    return [];
  }
  return scanBundledSkillDirectories(skillsRoot);
}
