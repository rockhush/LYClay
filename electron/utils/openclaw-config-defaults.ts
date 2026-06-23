export const DEFAULT_OPENCLAW_DM_SCOPE = 'per-account-channel-peer';
export const DEFAULT_OPENCLAW_AGENT_MAX_CONCURRENT = 8;

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

  if (previousMaxConcurrent === DEFAULT_OPENCLAW_AGENT_MAX_CONCURRENT) {
    return false;
  }

  defaults.maxConcurrent = DEFAULT_OPENCLAW_AGENT_MAX_CONCURRENT;
  agents.defaults = defaults;
  config.agents = agents;

  return true;
}
