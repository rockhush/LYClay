/**
 * Prompt Resource Cache
 *
 * Caches parsed prompt resources (CLAUDE.md, agent.md, skill metadata)
 * to avoid redundant file I/O and markdown parsing on every request.
 *
 * Invalidation strategy:
 * - Check mtimeMs + size before using cached content
 * - Active invalidation on directory/agent/skill changes
 * - Lazy re-validation on access
 */

import { stat, readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from '../utils/logger';
import { getOpenClawConfigDir } from '../utils/paths';

export interface FileSignature {
  mtimeMs: number;
  size: number;
}

export interface PromptResourceEntry {
  path: string;
  signature: FileSignature;
  content: string;
  parsed?: ParsedPromptContent;
  loadedAt: number;
  accessCount: number;
}

export interface ParsedPromptContent {
  sections: PromptSection[];
  metadata: Record<string, unknown>;
  rawMarkdown: string;
}

export interface PromptSection {
  heading: string;
  level: number;
  content: string;
  order: number;
}

interface PromptResourceCacheState {
  resources: Map<string, PromptResourceEntry>;
  lastScanAt: number;
  scanCount: number;
}

const cache: PromptResourceCacheState = {
  resources: new Map(),
  lastScanAt: 0,
  scanCount: 0,
};

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CACHED_RESOURCES = 50;

/**
 * Check if a file has changed since it was cached
 */
async function hasFileChanged(path: string, cachedSignature: FileSignature): Promise<boolean> {
  try {
    const fileStat = await stat(path);
    return fileStat.mtimeMs !== cachedSignature.mtimeMs || fileStat.size !== cachedSignature.size;
  } catch {
    return true; // Assume changed if we can't stat it
  }
}

/**
 * Parse markdown content into sections (simple heuristic-based parsing)
 */
function parseMarkdownSections(content: string): PromptSection[] {
  const sections: PromptSection[] = [];
  const lines = content.split(/\r?\n/);
  let currentSection: PromptSection | null = null;
  let currentContent: string[] = [];
  let order = 0;

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);

    if (headingMatch) {
      // Save previous section
      if (currentSection) {
        currentSection.content = currentContent.join('\n').trim();
        sections.push(currentSection);
        currentContent = [];
      }

      // Start new section
      currentSection = {
        heading: headingMatch[2].trim(),
        level: headingMatch[1].length,
        content: '',
        order: order++,
      };
    } else if (currentSection) {
      currentContent.push(line);
    }
  }

  // Save last section
  if (currentSection) {
    currentSection.content = currentContent.join('\n').trim();
    sections.push(currentSection);
  }

  return sections;
}

/**
 * Get or load a prompt resource
 * Returns cached content if signature matches, otherwise reloads
 */
export async function getPromptResource(
  resourceName: string,
  basePath?: string,
): Promise<PromptResourceEntry | null> {
  const configDir = basePath || getOpenClawConfigDir();
  const resourcePath = join(configDir, resourceName);

  const cached = cache.resources.get(resourcePath);

  // Check if cached entry is still valid
  if (cached) {
    const isChanged = await hasFileChanged(resourcePath, cached.signature);
    if (!isChanged) {
      // Check TTL
      const age = Date.now() - cached.loadedAt;
      if (age < CACHE_TTL_MS) {
        cached.accessCount += 1;
        logger.debug(`[prompt-cache] Hit for ${resourceName} (age=${age}ms, accesses=${cached.accessCount})`);
        return cached;
      }
    }

    // Remove stale entry
    cache.resources.delete(resourcePath);
    logger.debug(`[prompt-cache] Evicted stale entry for ${resourceName}`);
  }

  // Load and cache the resource
  try {
    const fileStat = await stat(resourcePath);
    const content = await readFile(resourcePath, 'utf-8');

    const entry: PromptResourceEntry = {
      path: resourcePath,
      signature: {
        mtimeMs: fileStat.mtimeMs,
        size: fileStat.size,
      },
      content,
      parsed: {
        sections: parseMarkdownSections(content),
        metadata: {},
        rawMarkdown: content,
      },
      loadedAt: Date.now(),
      accessCount: 1,
    };

    // Enforce max cache size (LRU-style eviction)
    if (cache.resources.size >= MAX_CACHED_RESOURCES) {
      evictLeastAccessed();
    }

    cache.resources.set(resourcePath, entry);
    cache.lastScanAt = Date.now();
    cache.scanCount += 1;

    logger.info(`[prompt-cache] Cached ${resourceName} (size=${fileStat.size} bytes)`);
    return entry;
  } catch (error) {
    logger.warn(`[prompt-cache] Failed to load ${resourceName}:`, error);
    return null;
  }
}

/**
 * Evict least accessed entries from cache
 */
function evictLeastAccessed(): void {
  const entries = Array.from(cache.resources.entries());
  entries.sort((a, b) => a[1].accessCount - b[1].accessCount);

  const toEvict = Math.floor(entries.length * 0.25); // Evict 25%
  for (let i = 0; i < toEvict; i++) {
    const [path] = entries[i];
    cache.resources.delete(path);
  }

  logger.debug(`[prompt-cache] Evicted ${toEvict} least accessed entries`);
}

/**
 * Get raw content of a prompt resource
 */
export async function getPromptContent(
  resourceName: string,
  basePath?: string,
): Promise<string | null> {
  const entry = await getPromptResource(resourceName, basePath);
  return entry?.content ?? null;
}

/**
 * Get parsed sections of a prompt resource
 */
export async function getParsedPrompt(
  resourceName: string,
  basePath?: string,
): Promise<ParsedPromptContent | null> {
  const entry = await getPromptResource(resourceName, basePath);
  return entry?.parsed ?? null;
}

/**
 * Invalidate a specific resource
 */
export function invalidatePromptResource(resourceName: string): void {
  const configDir = getOpenClawConfigDir();
  const resourcePath = join(configDir, resourceName);
  if (cache.resources.delete(resourcePath)) {
    logger.debug(`[prompt-cache] Invalidated ${resourceName}`);
  }
}

/**
 * Clear all cached resources
 */
export function clearPromptCache(): void {
  cache.resources.clear();
  cache.lastScanAt = Date.now();
  logger.info('[prompt-cache] Cleared all cached resources');
}

/**
 * Preload common prompt resources
 */
export async function preloadCommonPrompts(): Promise<void> {
  const commonResources = [
    'CLAUDE.md',
    'agent.md',
  ];

  logger.info('[prompt-cache] Preloading common prompt resources...');
  const start = Date.now();

  for (const resource of commonResources) {
    await getPromptContent(resource);
  }

  logger.info(`[prompt-cache] Preloaded ${commonResources.length} resources in ${Date.now() - start}ms`);
}

/**
 * Get cache diagnostics
 */
export function getCacheDiagnostics(): {
  resourceCount: number;
  lastScanAt: number;
  scanCount: number;
  resources: Array<{ name: string; size: number; accesses: number }>;
} {
  const resources = Array.from(cache.resources.entries()).map(([path, entry]) => ({
    name: path.split('/').pop() || path,
    size: entry.signature.size,
    accesses: entry.accessCount,
  }));

  return {
    resourceCount: cache.resources.size,
    lastScanAt: cache.lastScanAt,
    scanCount: cache.scanCount,
    resources,
  };
}

/**
 * Scan and cache all prompt resources in a directory
 */
export async function scanPromptResources(
  directory: string,
  patterns: string[] = ['*.md'],
): Promise<PromptResourceEntry[]> {
  const { readdir } = await import('fs/promises');
  const entries: PromptResourceEntry[] = [];

  try {
    const files = await readdir(directory);

    for (const file of files) {
      const matches = patterns.some((pattern) => {
        const regex = new RegExp(pattern.replace(/\*/g, '.*'));
        return regex.test(file);
      });

      if (matches) {
        const entry = await getPromptResource(file, directory);
        if (entry) {
          entries.push(entry);
        }
      }
    }

    logger.info(`[prompt-cache] Scanned ${entries.length} prompt resources in ${directory}`);
  } catch (error) {
    logger.warn(`[prompt-cache] Failed to scan ${directory}:`, error);
  }

  return entries;
}
