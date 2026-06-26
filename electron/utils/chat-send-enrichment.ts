import {
  buildChannelMessageTargetSystemPrompt,
  mergeExtraSystemPrompt,
  resolveSessionDeliveryContext,
} from './session-delivery-context';

export async function enrichChatSendParams(params: unknown): Promise<unknown> {
  if (!params || typeof params !== 'object') return params;

  const record = params as Record<string, unknown>;
  const sessionKey = typeof record.sessionKey === 'string' ? record.sessionKey.trim() : '';
  if (!sessionKey || sessionKey === 'agent:main:__warmup__') {
    return params;
  }

  const deliveryContext = await resolveSessionDeliveryContext(sessionKey);
  if (!deliveryContext) {
    return params;
  }

  const prompt = buildChannelMessageTargetSystemPrompt(deliveryContext);
  const existing = typeof record.extraSystemPrompt === 'string'
    ? record.extraSystemPrompt
    : undefined;

  return {
    ...record,
    extraSystemPrompt: mergeExtraSystemPrompt(existing, prompt),
  };
}
