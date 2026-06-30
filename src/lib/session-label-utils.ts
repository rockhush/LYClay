const PLACEHOLDER_SESSION_TITLES = new Set([
  'lyclaw',
  'lyclaw ui',
]);

export function isPlaceholderSessionTitle(value: string | undefined | null): boolean {
  if (!value?.trim()) return true;
  const trimmed = value.trim();
  if (PLACEHOLDER_SESSION_TITLES.has(trimmed.toLowerCase())) return true;
  if (trimmed.startsWith('agent:')) return true;
  return false;
}

export function resolveSessionDisplayLabel(params: {
  sessionKey: string;
  customLabel?: string;
  sessionLabel?: string;
  firstUserMessagePreview?: string;
  label?: string;
  displayName?: string;
}): string {
  const candidates = [
    params.customLabel,
    params.sessionLabel,
    params.firstUserMessagePreview,
    params.label,
    params.displayName,
    params.sessionKey,
  ];

  for (const candidate of candidates) {
    if (!candidate?.trim()) continue;
    const cleaned = candidate.replace(/\/think\s+(off|medium|high)\s+/i, '').trim();
    if (!isPlaceholderSessionTitle(cleaned)) {
      return cleaned;
    }
  }

  return params.sessionKey;
}

export function collectAgentIdsFromSessionKeys(sessionKeys: string[]): string[] {
  const ids = new Set<string>(['main']);
  for (const sessionKey of sessionKeys) {
    if (!sessionKey.startsWith('agent:')) continue;
    const [, agentId] = sessionKey.split(':');
    if (agentId) ids.add(agentId);
  }
  return [...ids];
}
