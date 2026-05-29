/**
 * Session Runtime Snapshot Cache
 *
 * Caches resolved agent + model + provider information for each session
 * to avoid re-resolving from multiple stores, RPC calls, and config files
 * on every chat.send request.
 *
 * Invalidation strategy:
 * - Global runtimeVersion is bumped on any config change
 * - Each snapshot stores the version at creation time
 * - Stale snapshots are rebuilt on next access
 */

import { logger } from '../utils/logger';
import type { AgentSummary } from '../utils/agent-config';

export interface SessionRuntimeSnapshot {
  sessionKey: string;
  agentId: string;
  modelRef: string;
  providerId: string;
  accountId?: string;
  thinkingLevel: 'off' | 'medium' | 'high';
  supportsTools: boolean;
  supportsMedia: boolean;
  supportsStreaming: boolean;
  updatedAt: number;
  version: number; // Global runtime version at snapshot creation
}

export interface SessionRuntimeCacheState {
  snapshots: Map<string, SessionRuntimeSnapshot>;
  runtimeVersion: number;
  lastRebuildAt: number;
}

const cache: SessionRuntimeCacheState = {
  snapshots: new Map(),
  runtimeVersion: 0,
  lastRebuildAt: 0,
};

/**
 * Increment the global runtime version.
 * Call this whenever:
 * - User switches model
 * - User switches agent
 * - Provider/account auth changes
 * - Agent config changes
 * - Session thinking level changes
 */
export function bumpRuntimeVersion(): void {
  cache.runtimeVersion += 1;
  cache.lastRebuildAt = Date.now();
  logger.info(`[session-runtime] Bumped runtime version to ${cache.runtimeVersion}`);
}

/**
 * Get current runtime version
 */
export function getRuntimeVersion(): number {
  return cache.runtimeVersion;
}

/**
 * Build a snapshot from resolved agent/provider information
 */
function buildSnapshot(
  sessionKey: string,
  agent: AgentSummary,
  overrides?: Partial<SessionRuntimeSnapshot>,
): SessionRuntimeSnapshot {
  return {
    sessionKey,
    agentId: agent.id,
    modelRef: agent.modelRef || 'anthropic/claude-sonnet-4-5',
    providerId: extractProviderId(agent.modelRef),
    accountId: undefined, // TODO: resolve from provider store
    thinkingLevel: (overrides?.thinkingLevel as 'off' | 'medium' | 'high') ?? 'off',
    supportsTools: true, // TODO: resolve from provider capabilities
    supportsMedia: true,
    supportsStreaming: true,
    updatedAt: Date.now(),
    version: cache.runtimeVersion,
    ...overrides,
  };
}

/**
 * Extract provider ID from modelRef (e.g., "anthropic/claude-3-5-sonnet" -> "anthropic")
 */
function extractProviderId(modelRef: string): string {
  const firstSlash = modelRef.indexOf('/');
  if (firstSlash > 0) {
    return modelRef.slice(0, firstSlash);
  }
  // Fallback: try to extract from common patterns
  if (modelRef.includes('claude')) return 'anthropic';
  if (modelRef.includes('gpt')) return 'openai';
  if (modelRef.includes('gemini')) return 'google';
  if (modelRef.includes('qwen')) return 'qwen';
  return 'unknown';
}

/**
 * Get or create a runtime snapshot for a session
 * Returns cached snapshot if version matches, otherwise rebuilds
 */
export async function getSessionRuntimeSnapshot(
  sessionKey: string,
  agentResolver: (sessionKey: string) => Promise<AgentSummary>,
): Promise<SessionRuntimeSnapshot> {
  const cached = cache.snapshots.get(sessionKey);

  // Return cached snapshot if version matches
  if (cached && cached.version === cache.runtimeVersion) {
    logger.debug(`[session-runtime] Cache hit for ${sessionKey} (version=${cached.version})`);
    return cached;
  }

  // Rebuild snapshot
  logger.debug(`[session-runtime] Cache miss for ${sessionKey}, rebuilding...`);

  try {
    const agent = await agentResolver(sessionKey);
    const snapshot = buildSnapshot(sessionKey, agent);
    cache.snapshots.set(sessionKey, snapshot);
    logger.info(`[session-runtime] Cached snapshot for ${sessionKey} (agent=${agent.id}, model=${agent.modelRef})`);
    return snapshot;
  } catch (error) {
    logger.warn(`[session-runtime] Failed to build snapshot for ${sessionKey}:`, error);

    // Return stale snapshot if exists (better than nothing)
    if (cached) {
      logger.warn(`[session-runtime] Returning stale snapshot for ${sessionKey}`);
      return cached;
    }

    // Create minimal fallback snapshot
    const fallback: SessionRuntimeSnapshot = {
      sessionKey,
      agentId: 'main',
      modelRef: 'anthropic/claude-sonnet-4-5',
      providerId: 'anthropic',
      accountId: undefined,
      thinkingLevel: 'off',
      supportsTools: true,
      supportsMedia: false,
      supportsStreaming: true,
      updatedAt: Date.now(),
      version: cache.runtimeVersion,
    };
    cache.snapshots.set(sessionKey, fallback);
    return fallback;
  }
}

/**
 * Invalidate a specific session's snapshot
 * Call this when session-specific config changes
 */
export function invalidateSessionSnapshot(sessionKey: string): void {
  if (cache.snapshots.delete(sessionKey)) {
    logger.debug(`[session-runtime] Invalidated snapshot for ${sessionKey}`);
  }
}

/**
 * Clear all cached snapshots
 * Call this on app restart or major config changes
 */
export function clearAllSnapshots(): void {
  cache.snapshots.clear();
  logger.info('[session-runtime] Cleared all snapshots');
}

/**
 * Get cache diagnostics for debugging
 */
export function getCacheDiagnostics(): {
  snapshotCount: number;
  runtimeVersion: number;
  lastRebuildAt: number;
  sessionKeys: string[];
} {
  return {
    snapshotCount: cache.snapshots.size,
    runtimeVersion: cache.runtimeVersion,
    lastRebuildAt: cache.lastRebuildAt,
    sessionKeys: Array.from(cache.snapshots.keys()),
  };
}

/**
 * Pre-build snapshots for active sessions (e.g., on app startup)
 */
export async function preloadSessionSnapshots(
  sessionKeys: string[],
  agentResolver: (sessionKey: string) => Promise<AgentSummary>,
): Promise<void> {
  logger.info(`[session-runtime] Preloading ${sessionKeys.length} session snapshots...`);

  const start = Date.now();
  const promises = sessionKeys.map((key) =>
    getSessionRuntimeSnapshot(key, agentResolver).catch((err) => {
      logger.warn(`[session-runtime] Failed to preload snapshot for ${key}:`, err);
    })
  );

  await Promise.all(promises);
  logger.info(`[session-runtime] Preloaded ${sessionKeys.length} snapshots in ${Date.now() - start}ms`);
}
