/**
 * Skill Config Utilities
 * Direct read/write access to skill configuration in ~/.openclaw/openclaw.json
 * This bypasses the Gateway RPC for faster and more reliable config updates.
 *
 * All file I/O uses async fs/promises to avoid blocking the main thread.
 */
import { readFile, writeFile, access } from 'fs/promises';
import { existsSync } from 'fs';
import { constants } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getResourcesDir } from './paths';
import { logger } from './logger';
import { withConfigLock } from './config-mutex';
import { ensureOpenClawSessionDefaults, type OpenClawDmScope } from './openclaw-config-defaults';

const OPENCLAW_CONFIG_PATH = join(homedir(), '.openclaw', 'openclaw.json');

interface SkillEntry {
    enabled?: boolean;
    apiKey?: string;
    env?: Record<string, string>;
}

interface OpenClawConfig {
    skills?: {
        entries?: Record<string, SkillEntry>;
        [key: string]: unknown;
    };
    session?: {
        dmScope?: OpenClawDmScope;
        [key: string]: unknown;
    };
    [key: string]: unknown;
}

interface PreinstalledSkillSpec {
    slug: string;
    version?: string;
    autoEnable?: boolean;
}

interface PreinstalledManifest {
    skills?: PreinstalledSkillSpec[];
}

async function fileExists(p: string): Promise<boolean> {
    try { await access(p, constants.F_OK); return true; } catch { return false; }
}

/**
 * Read the current OpenClaw config
 */
async function readConfig(): Promise<OpenClawConfig> {
    if (!(await fileExists(OPENCLAW_CONFIG_PATH))) {
        return {};
    }
    try {
        const raw = await readFile(OPENCLAW_CONFIG_PATH, 'utf-8');
        return JSON.parse(raw);
    } catch (err) {
        console.error('Failed to read openclaw config:', err);
        return {};
    }
}

/**
 * Write the OpenClaw config
 */
async function writeConfig(config: OpenClawConfig): Promise<void> {
    ensureOpenClawSessionDefaults(config as Record<string, unknown>);
    const json = JSON.stringify(config, null, 2);
    await writeFile(OPENCLAW_CONFIG_PATH, json, 'utf-8');
}

export function normalizeSkillConfigLookupKey(value: string): string {
    return value.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

export async function resolveSkillConfigKey(candidates: string[]): Promise<string> {
    const uniqueCandidates = [...new Set(
        candidates.map((candidate) => candidate.trim()).filter(Boolean),
    )];
    if (uniqueCandidates.length === 0) {
        throw new Error('skillKey is required');
    }

    const config = await readConfig();
    const entries = config.skills?.entries || {};

    for (const candidate of uniqueCandidates) {
        if (Object.prototype.hasOwnProperty.call(entries, candidate)) {
            return candidate;
        }
    }

    const normalizedIndex = new Map<string, string>();
    for (const key of Object.keys(entries)) {
        normalizedIndex.set(normalizeSkillConfigLookupKey(key), key);
    }

    for (const candidate of uniqueCandidates) {
        const matched = normalizedIndex.get(normalizeSkillConfigLookupKey(candidate));
        if (matched) {
            return matched;
        }
    }

    return uniqueCandidates[0];
}

export async function setSkillEnabled(
    skillKey: string,
    enabled: boolean,
    aliases: { slug?: string; name?: string } = {},
): Promise<{ success: boolean; skillKey: string; error?: string }> {
    try {
        const resolvedKey = await resolveSkillConfigKey([
            skillKey,
            aliases.slug,
            aliases.name,
        ].filter((value): value is string => Boolean(value && value.trim())));

        await withConfigLock(async () => {
            const config = await readConfig();
            if (!config.skills) {
                config.skills = {};
            }
            if (!config.skills.entries) {
                config.skills.entries = {};
            }
            const entry = config.skills.entries[resolvedKey] || {};
            entry.enabled = enabled;
            config.skills.entries[resolvedKey] = entry;
            await writeConfig(config);
        });

        return { success: true, skillKey: resolvedKey };
    } catch (err) {
        logger.error(`Failed to set skill enabled state for "${skillKey}":`, err);
        return { success: false, skillKey, error: String(err) };
    }
}

async function setSkillsEnabled(skillKeys: string[], enabled: boolean): Promise<void> {
    if (skillKeys.length === 0) {
        return;
    }
    for (const skillKey of skillKeys) {
        const result = await setSkillEnabled(skillKey, enabled);
        if (!result.success) {
            throw new Error(result.error || `Failed to update skill "${skillKey}"`);
        }
    }
}

/**
 * Get skill config
 */
export async function getSkillConfig(skillKey: string): Promise<SkillEntry | undefined> {
    const config = await readConfig();
    return config.skills?.entries?.[skillKey];
}

/**
 * Update skill config (apiKey and env)
 */
export async function updateSkillConfig(
    skillKey: string,
    updates: { apiKey?: string; env?: Record<string, string> }
): Promise<{ success: boolean; error?: string }> {
    try {
        return await withConfigLock(async () => {
            const config = await readConfig();

            // Ensure skills.entries exists
            if (!config.skills) {
                config.skills = {};
            }
            if (!config.skills.entries) {
                config.skills.entries = {};
            }

            // Get or create skill entry
            const entry = config.skills.entries[skillKey] || {};

            // Update apiKey
            if (updates.apiKey !== undefined) {
                const trimmed = updates.apiKey.trim();
                if (trimmed) {
                    entry.apiKey = trimmed;
                } else {
                    delete entry.apiKey;
                }
            }

            // Update env
            if (updates.env !== undefined) {
                const newEnv: Record<string, string> = {};

                for (const [key, value] of Object.entries(updates.env)) {
                    const trimmedKey = key.trim();
                    if (!trimmedKey) continue;

                    const trimmedVal = value.trim();
                    if (trimmedVal) {
                        newEnv[trimmedKey] = trimmedVal;
                    }
                }

                if (Object.keys(newEnv).length > 0) {
                    entry.env = newEnv;
                } else {
                    delete entry.env;
                }
            }

            // Save entry back
            config.skills.entries[skillKey] = entry;

            await writeConfig(config);
            return { success: true };
        });
    } catch (err) {
        console.error('Failed to update skill config:', err);
        return { success: false, error: String(err) };
    }
}

/**
 * Get all skill configs (for syncing to frontend)
 */
export async function getAllSkillConfigs(): Promise<Record<string, SkillEntry>> {
    const config = await readConfig();
    return config.skills?.entries || {};
}

const PREINSTALLED_MANIFEST_NAME = 'preinstalled-manifest.json';

async function readPreinstalledManifest(): Promise<PreinstalledSkillSpec[]> {
    const candidates = [
        join(getResourcesDir(), 'skills', PREINSTALLED_MANIFEST_NAME),
        join(process.cwd(), 'resources', 'skills', PREINSTALLED_MANIFEST_NAME),
    ];

    const manifestPath = candidates.find((p) => existsSync(p));
    if (!manifestPath) {
        return [];
    }

    try {
        const raw = await readFile(manifestPath, 'utf-8');
        const parsed = JSON.parse(raw) as PreinstalledManifest;
        if (!Array.isArray(parsed.skills)) {
            return [];
        }
        return parsed.skills.filter((s): s is PreinstalledSkillSpec => Boolean(s?.slug));
    } catch (error) {
        logger.warn('Failed to read preinstalled-skills manifest:', error);
        return [];
    }
}

/**
 * Auto-enable skills flagged in preinstalled-manifest (bundled under openclaw/skills).
 * Does not copy files into ~/.openclaw/skills.
 */
export async function ensurePreinstalledSkillsConfig(): Promise<void> {
    const skills = await readPreinstalledManifest();
    const toEnable = skills.filter((s) => s.autoEnable).map((s) => s.slug);
    if (toEnable.length === 0) {
        return;
    }
    try {
        await setSkillsEnabled(toEnable, true);
    } catch (error) {
        logger.warn('Failed to auto-enable bundled preinstalled skills:', error);
    }
}
