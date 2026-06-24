export const DEFAULT_OPENCLAW_DM_SCOPE = 'per-account-channel-peer';
export const DEFAULT_OPENCLAW_AGENT_MAX_CONCURRENT = 8;

export const DEFAULT_OPENCLAW_COMPACTION_CONFIG: Record<string, unknown> = {
  mode: 'default',
  reserveTokensFloor: 30000,
  keepRecentTokens: 40000,
  timeoutSeconds: 900,
  notifyUser: true,
  memoryFlush: {
    enabled: true,
    softThresholdTokens: 8000,
  },
};

export type OpenClawDmScope =
  | 'main'
  | 'per-peer'
  | 'per-channel-peer'
  | 'per-account-channel-peer';

const VALID_OPENCLAW_DM_SCOPES = new Set<OpenClawDmScope>([
  'main',
  'per-peer',
  'per-channel-peer',
  'per-account-channel-peer',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function ensureOpenClawSessionDefaults(config: Record<string, unknown>): boolean {
  const previousSession = config.session;
  const session = isRecord(previousSession) ? previousSession : {};
  const previousDmScope = session.dmScope;

  if (typeof previousDmScope === 'string' && VALID_OPENCLAW_DM_SCOPES.has(previousDmScope as OpenClawDmScope)) {
    return false;
  }

  session.dmScope = DEFAULT_OPENCLAW_DM_SCOPE;
  config.session = session;

  return !isRecord(previousSession) || previousDmScope !== DEFAULT_OPENCLAW_DM_SCOPE;
}

export function ensureOpenClawAgentDefaults(config: Record<string, unknown>): boolean {
  const previousAgents = config.agents;
  const agents = isRecord(previousAgents) ? previousAgents : {};
  const previousDefaults = agents.defaults;
  const defaults = isRecord(previousDefaults) ? previousDefaults : {};
  const previousMaxConcurrent = defaults.maxConcurrent;

  let changed = false;

  if (previousMaxConcurrent !== DEFAULT_OPENCLAW_AGENT_MAX_CONCURRENT) {
    defaults.maxConcurrent = DEFAULT_OPENCLAW_AGENT_MAX_CONCURRENT;
    changed = true;
  }

  // Ensure compaction defaults are applied, fixing any broken legacy config
  const previousCompaction = defaults.compaction;
  const compaction = isRecord(previousCompaction) ? { ...previousCompaction } : {};

  let compactionChanged = false;

  // Fix: "safeguard" mode requires an external compaction provider. If no
  // provider is configured, force back to "default" so Pi's built-in auto-
  // compaction takes over. Also fill in missing fields with safe defaults.
  if (compaction.mode !== 'default') {
    compaction.mode = 'default';
    compactionChanged = true;
  }

  if (!compaction.notifyUser) {
    compaction.notifyUser = true;
    compactionChanged = true;
  }

  if (typeof compaction.reserveTokensFloor !== 'number' || compaction.reserveTokensFloor <= 0) {
    compaction.reserveTokensFloor = DEFAULT_OPENCLAW_COMPACTION_CONFIG.reserveTokensFloor;
    compactionChanged = true;
  }

  if (typeof compaction.keepRecentTokens !== 'number' || compaction.keepRecentTokens <= 0) {
    compaction.keepRecentTokens = DEFAULT_OPENCLAW_COMPACTION_CONFIG.keepRecentTokens;
    compactionChanged = true;
  }

  if (typeof compaction.timeoutSeconds !== 'number' || compaction.timeoutSeconds <= 0) {
    compaction.timeoutSeconds = DEFAULT_OPENCLAW_COMPACTION_CONFIG.timeoutSeconds;
    compactionChanged = true;
  }

  if (!isRecord(compaction.memoryFlush)) {
    compaction.memoryFlush = DEFAULT_OPENCLAW_COMPACTION_CONFIG.memoryFlush;
    compactionChanged = true;
  }

  if (compactionChanged) {
    defaults.compaction = compaction;
    changed = true;
  }

  agents.defaults = defaults;
  config.agents = agents;

  return changed || !isRecord(previousAgents);
}
