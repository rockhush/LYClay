import {
  buildChannelMessageTargetSystemPrompt,
  mergeExtraSystemPrompt,
  resolveSessionDeliveryContext,
} from './session-delivery-context';

function normalizeSkillFilter(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean);
  return names.length > 0 ? names : undefined;
}

export async function enrichChatSendParams(params: unknown): Promise<unknown> {
  if (!params || typeof params !== 'object') return params;

  const record = params as Record<string, unknown>;
  const sessionKey = typeof record.sessionKey === 'string' ? record.sessionKey.trim() : '';
  const skillFilter = normalizeSkillFilter(record.skillFilter);
  const enriched: Record<string, unknown> = skillFilter ? { ...record, skillFilter } : { ...record };

  if (!sessionKey || sessionKey === 'agent:main:__warmup__') {
    return enriched;
  }

  const deliveryContext = await resolveSessionDeliveryContext(sessionKey);
  if (!deliveryContext) {
    return enriched;
  }

  const prompt = buildChannelMessageTargetSystemPrompt(deliveryContext);
  const existing = typeof enriched.extraSystemPrompt === 'string'
    ? enriched.extraSystemPrompt
    : undefined;

  return {
    ...enriched,
    extraSystemPrompt: mergeExtraSystemPrompt(existing, prompt),
  };
}
