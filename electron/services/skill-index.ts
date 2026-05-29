/**
 * Skill Index Service
 *
 * Maintains a lightweight index of available skills for prompt injection.
 * Skills are loaded on-demand when triggered by user requests.
 *
 * Benefits:
 * - Reduces prompt token count
 * - Improves first-token latency
 * - Reduces model confusion from irrelevant skills
 */

import { readFile, access } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from '../utils/logger';
import { getAllSkillConfigs } from '../utils/skill-config';
import { getPromptContent } from './prompt-resource-cache';

export interface SkillIndexEntry {
  name: string;
  slug: string;
  description: string; // One-line description
  triggers: string[]; // Keywords or commands that trigger this skill
  requiresLoading: boolean; // True if skill needs explicit loading
  enabled: boolean;
  installed: boolean;
}

export interface SkillIndexState {
  entries: Map<string, SkillIndexEntry>;
  lastBuiltAt: number;
  loadCount: number;
}

const cache: SkillIndexState = {
  entries: new Map(),
  lastBuiltAt: 0,
  loadCount: 0,
};

/**
 * Parse skill metadata from manifest or directory name
 */
function parseSkillMetadata(
  skillKey: string,
  skillDir: string,
): { name: string; description: string; triggers: string[] } | null {
  // Try to read skill manifest first
  const manifestPath = join(skillDir, 'skill.json');

  try {
    // Check if manifest exists
    await access(manifestPath);

    // Would need to read and parse JSON here
    // For now, fall through to default extraction
  } catch {
    // No manifest, use defaults
  }

  // Extract from directory name as fallback
  const name = skillKey
    .split(/[-_]/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ');

  return {
    name,
    description: `Skill: ${name}`,
    triggers: [`/${skillKey.toLowerCase()}`],
  };
}

/**
 * Build the skill index from installed skills
 */
export async function buildSkillIndex(): Promise<SkillIndexEntry[]> {
  logger.info('[skill-index] Building skill index...');
  const start = Date.now();

  try {
    // Get all configured skills
    const configuredSkills = await getAllSkillConfigs();
    const entries: SkillIndexEntry[] = [];

    // Build index entries for each skill
    for (const [skillKey, config] of Object.entries(configuredSkills)) {
      const enabled = config.enabled !== false;
      const hasApiKey = Boolean(config.apiKey);

      // Try to get skill metadata from directory
      const skillsDir = join(homedir(), '.openclaw', 'skills');
      const skillDir = join(skillsDir, skillKey);

      const metadata = await parseSkillMetadata(skillKey, skillDir);
      if (!metadata) {
        logger.warn(`[skill-index] Failed to parse metadata for ${skillKey}`);
        continue;
      }

      entries.push({
        name: metadata.name,
        slug: skillKey,
        description: metadata.description,
        triggers: metadata.triggers,
        requiresLoading: true,
        enabled,
        installed: hasApiKey || enabled,
      });
    }

    // Update cache
    cache.entries.clear();
    for (const entry of entries) {
      cache.entries.set(entry.slug, entry);
    }
    cache.lastBuiltAt = Date.now();
    cache.loadCount += 1;

    logger.info(`[skill-index] Built index with ${entries.length} entries in ${Date.now() - start}ms`);
    return entries;
  } catch (error) {
    logger.error('[skill-index] Failed to build index:', error);
    return [];
  }
}

/**
 * Get the skill index as a markdown-formatted string for prompt injection
 */
export async function getSkillIndexMarkdown(): Promise<string> {
  if (cache.entries.size === 0) {
    await buildSkillIndex();
  }

  const enabledSkills = Array.from(cache.entries.values()).filter((e) => e.enabled);

  if (enabledSkills.length === 0) {
    return 'No skills available.';
  }

  const lines: string[] = [
    '## Available Skills',
    '',
    'Use these skills for specialized tasks. Load a skill by using its command or describing the task.',
    '',
  ];

  for (const skill of enabledSkills) {
    const triggers = skill.triggers.join(', ');
    lines.push(`- **${skill.name}** (${skill.slug}): ${skill.description}`);
    lines.push(`  - Triggers: ${triggers}`);
    lines.push(`  - Command: \`/${skill.slug}\``);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Check if a message matches any skill triggers
 */
export function matchSkillTrigger(message: string): string[] {
  const normalizedMessage = message.toLowerCase();
  const matchedSkills: string[] = [];

  for (const [skillKey, entry] of cache.entries.entries()) {
    if (!entry.enabled) continue;

    // Check explicit command
    if (message.startsWith(`/${skillKey}`) || message.startsWith(`/${entry.name.toLowerCase()}`)) {
      matchedSkills.push(skillKey);
      continue;
    }

    // Check natural language triggers
    for (const trigger of entry.triggers) {
      const normalizedTrigger = trigger.toLowerCase();
      if (normalizedMessage.includes(normalizedTrigger)) {
        matchedSkills.push(skillKey);
        break;
      }
    }
  }

  return matchedSkills;
}

/**
 * Load a specific skill's full content
 */
export async function loadSkillContent(skillKey: string): Promise<string | null> {
  logger.info(`[skill-index] Loading skill content: ${skillKey}`);

  const entry = cache.entries.get(skillKey);
  if (!entry) {
    logger.warn(`[skill-index] Skill not found: ${skillKey}`);
    return null;
  }

  // Try to load skill README or main file
  const skillsDir = join(homedir(), '.openclaw', 'skills');
  const skillDir = join(skillsDir, skillKey);

  const candidateFiles = [
    'SKILL.md',
    'README.md',
    'skill.md',
    'INSTRUCTIONS.md',
  ];

  for (const file of candidateFiles) {
    const content = await getPromptContent(file, skillDir);
    if (content) {
      logger.info(`[skill-index] Loaded skill content from ${file}`);
      return content;
    }
  }

  logger.warn(`[skill-index] No content found for skill: ${skillKey}`);
  return null;
}

/**
 * Build enhanced prompt with loaded skill content
 */
export function buildSkillEnhancedPrompt(
  basePrompt: string,
  skillContent: string,
  skillName: string,
): string {
  return `${basePrompt}

## Active Skill: ${skillName}

${skillContent}

Follow the instructions above for this skill.
`;
}

/**
 * Get skills that match user intent
 */
export function getMatchingSkills(message: string): SkillIndexEntry[] {
  const matchedKeys = matchSkillTrigger(message);
  return matchedKeys
    .map((key) => cache.entries.get(key))
    .filter((e): e is SkillIndexEntry => e !== undefined);
}

/**
 * Clear the skill index cache
 */
export function clearSkillIndex(): void {
  cache.entries.clear();
  cache.lastBuiltAt = 0;
  logger.info('[skill-index] Cleared cache');
}

/**
 * Get cache diagnostics
 */
export function getCacheDiagnostics(): {
  entryCount: number;
  lastBuiltAt: number;
  loadCount: number;
  enabledCount: number;
} {
  const enabledCount = Array.from(cache.entries.values()).filter((e) => e.enabled).length;

  return {
    entryCount: cache.entries.size,
    lastBuiltAt: cache.lastBuiltAt,
    loadCount: cache.loadCount,
    enabledCount,
  };
}
