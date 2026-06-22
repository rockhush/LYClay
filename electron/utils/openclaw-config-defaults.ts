export const DEFAULT_OPENCLAW_DM_SCOPE = 'per-account-channel-peer';
export const DEFAULT_OPENCLAW_AGENT_MAX_CONCURRENT = 8;
export const DEFAULT_OPENCLAW_AGENT_CONTEXT_TOKENS = 128000;
export const DEFAULT_OPENCLAW_AGENT_TOOL_RESULT_MAX_CHARS = 8000;
export const DEFAULT_OPENCLAW_COMPACTION_MODE = 'safeguard';
export const DEFAULT_OPENCLAW_COMPACTION_NOTIFY_USER = true;
export const DEFAULT_OPENCLAW_COMPACTION_RESERVE_TOKENS = 32768;
export const DEFAULT_OPENCLAW_COMPACTION_RESERVE_TOKENS_FLOOR = 32768;
export const DEFAULT_OPENCLAW_COMPACTION_KEEP_RECENT_TOKENS = 16000;
export const DEFAULT_OPENCLAW_COMPACTION_TRUNCATE_AFTER_COMPACTION = true;
export const DEFAULT_OPENCLAW_COMPACTION_MAX_ACTIVE_TRANSCRIPT_BYTES = '8mb';
export const DEFAULT_OPENCLAW_COMPACTION_MID_TURN_PRECHECK_ENABLED = true;

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
  const previousContextTokens = defaults.contextTokens;
  const previousContextLimits = defaults.contextLimits;
  const contextLimits = isRecord(previousContextLimits) ? previousContextLimits : {};
  const previousToolResultMaxChars = contextLimits.toolResultMaxChars;
  const previousCompaction = defaults.compaction;
  const compaction = isRecord(previousCompaction) ? previousCompaction : {};
  const previousMode = compaction.mode;
  const previousNotifyUser = compaction.notifyUser;
  const previousReserveTokens = compaction.reserveTokens;
  const previousReserveTokensFloor = compaction.reserveTokensFloor;
  const previousKeepRecentTokens = compaction.keepRecentTokens;
  const previousTruncateAfterCompaction = compaction.truncateAfterCompaction;
  const previousMaxActiveTranscriptBytes = compaction.maxActiveTranscriptBytes;
  const previousMidTurnPrecheck = compaction.midTurnPrecheck;
  const midTurnPrecheck = isRecord(previousMidTurnPrecheck) ? previousMidTurnPrecheck : {};
  const previousMidTurnPrecheckEnabled = midTurnPrecheck.enabled;

  const needsMaxConcurrent = previousMaxConcurrent !== DEFAULT_OPENCLAW_AGENT_MAX_CONCURRENT;
  const needsContextTokens = previousContextTokens !== DEFAULT_OPENCLAW_AGENT_CONTEXT_TOKENS;
  const needsToolResultMaxChars = previousToolResultMaxChars !== DEFAULT_OPENCLAW_AGENT_TOOL_RESULT_MAX_CHARS;
  const needsMode = previousMode !== DEFAULT_OPENCLAW_COMPACTION_MODE;
  const needsNotifyUser = previousNotifyUser !== DEFAULT_OPENCLAW_COMPACTION_NOTIFY_USER;
  const needsReserveTokens = previousReserveTokens !== DEFAULT_OPENCLAW_COMPACTION_RESERVE_TOKENS;
  const needsReserveTokensFloor = previousReserveTokensFloor !== DEFAULT_OPENCLAW_COMPACTION_RESERVE_TOKENS_FLOOR;
  const needsKeepRecentTokens = previousKeepRecentTokens !== DEFAULT_OPENCLAW_COMPACTION_KEEP_RECENT_TOKENS;
  const needsTruncateAfterCompaction =
    previousTruncateAfterCompaction !== DEFAULT_OPENCLAW_COMPACTION_TRUNCATE_AFTER_COMPACTION;
  const needsMaxActiveTranscriptBytes =
    previousMaxActiveTranscriptBytes !== DEFAULT_OPENCLAW_COMPACTION_MAX_ACTIVE_TRANSCRIPT_BYTES;
  const needsMidTurnPrecheckEnabled =
    previousMidTurnPrecheckEnabled !== DEFAULT_OPENCLAW_COMPACTION_MID_TURN_PRECHECK_ENABLED;

  if (
    !needsMaxConcurrent &&
    !needsContextTokens &&
    !needsToolResultMaxChars &&
    !needsMode &&
    !needsNotifyUser &&
    !needsReserveTokens &&
    !needsReserveTokensFloor &&
    !needsKeepRecentTokens &&
    !needsTruncateAfterCompaction &&
    !needsMaxActiveTranscriptBytes &&
    !needsMidTurnPrecheckEnabled
  ) {
    return false;
  }

  if (needsMaxConcurrent) {
    defaults.maxConcurrent = DEFAULT_OPENCLAW_AGENT_MAX_CONCURRENT;
  }
  if (needsContextTokens) {
    defaults.contextTokens = DEFAULT_OPENCLAW_AGENT_CONTEXT_TOKENS;
  }
  if (needsToolResultMaxChars) {
    contextLimits.toolResultMaxChars = DEFAULT_OPENCLAW_AGENT_TOOL_RESULT_MAX_CHARS;
    defaults.contextLimits = contextLimits;
  }
  if (needsMode) {
    compaction.mode = DEFAULT_OPENCLAW_COMPACTION_MODE;
  }
  if (needsNotifyUser) {
    compaction.notifyUser = DEFAULT_OPENCLAW_COMPACTION_NOTIFY_USER;
  }
  if (needsReserveTokens) {
    compaction.reserveTokens = DEFAULT_OPENCLAW_COMPACTION_RESERVE_TOKENS;
  }
  if (needsReserveTokensFloor) {
    compaction.reserveTokensFloor = DEFAULT_OPENCLAW_COMPACTION_RESERVE_TOKENS_FLOOR;
  }
  if (needsKeepRecentTokens) {
    compaction.keepRecentTokens = DEFAULT_OPENCLAW_COMPACTION_KEEP_RECENT_TOKENS;
  }
  if (needsTruncateAfterCompaction) {
    compaction.truncateAfterCompaction = DEFAULT_OPENCLAW_COMPACTION_TRUNCATE_AFTER_COMPACTION;
  }
  if (needsMaxActiveTranscriptBytes) {
    compaction.maxActiveTranscriptBytes = DEFAULT_OPENCLAW_COMPACTION_MAX_ACTIVE_TRANSCRIPT_BYTES;
  }
  if (needsMidTurnPrecheckEnabled) {
    midTurnPrecheck.enabled = DEFAULT_OPENCLAW_COMPACTION_MID_TURN_PRECHECK_ENABLED;
    compaction.midTurnPrecheck = midTurnPrecheck;
  }
  defaults.compaction = compaction;
  agents.defaults = defaults;
  config.agents = agents;

  return true;
}
