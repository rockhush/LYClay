import type { RawMessage } from './types';

function parseDurationMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isToolResultRole(role: unknown): boolean {
  if (!role) return false;
  const normalized = String(role).toLowerCase();
  return normalized === 'toolresult' || normalized === 'tool_result' || normalized === 'tool';
}

/** Normalize transcript/Gateway timestamps to epoch ms. */
export function getMessageTimestampMs(message: RawMessage): number | null {
  const msg = message as RawMessage & { timestamp?: number | string };
  if (typeof msg.timestamp === 'number' && Number.isFinite(msg.timestamp)) {
    return msg.timestamp > 1e12 ? msg.timestamp : msg.timestamp * 1000;
  }
  if (typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)) {
    return message.timestamp > 1e12 ? message.timestamp : message.timestamp * 1000;
  }
  if (typeof msg.timestamp === 'string') {
    const parsed = Date.parse(msg.timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export type TranscriptTimingMaps = {
  /** assistant message id (or synthetic index key) -> model wall time since prior transcript event */
  modelCallDurationByAssistantKey: Map<string, number>;
  /** toolCallId -> tool execution duration from toolResult.details.durationMs */
  toolDurationByToolCallId: Map<string, number>;
};

export function buildTranscriptTimingMaps(messages: RawMessage[]): TranscriptTimingMaps {
  const modelCallDurationByAssistantKey = new Map<string, number>();
  const toolDurationByToolCallId = new Map<string, number>();
  let lastTs: number | null = null;

  for (const [index, message] of messages.entries()) {
    const ts = getMessageTimestampMs(message);

    if (isToolResultRole(message.role)) {
      const toolCallId = typeof message.toolCallId === 'string' ? message.toolCallId : '';
      const details = message.details && typeof message.details === 'object'
        ? message.details as Record<string, unknown>
        : undefined;
      const durationMs = parseDurationMs(details?.durationMs ?? details?.duration);
      if (toolCallId && durationMs != null) {
        toolDurationByToolCallId.set(toolCallId, durationMs);
      }
    }

    if (message.role === 'assistant' && lastTs != null && ts != null) {
      const key = message.id ?? `assistant-${index}`;
      modelCallDurationByAssistantKey.set(key, Math.max(0, ts - lastTs));
    }

    if (ts != null) lastTs = ts;
  }

  return { modelCallDurationByAssistantKey, toolDurationByToolCallId };
}

export function enrichMessagesWithModelCallDurations(messages: RawMessage[]): RawMessage[] {
  const { modelCallDurationByAssistantKey } = buildTranscriptTimingMaps(messages);
  return messages.map((message, index) => {
    if (message.role !== 'assistant') return message;
    const key = message.id ?? `assistant-${index}`;
    const durationMs = modelCallDurationByAssistantKey.get(key);
    if (durationMs == null) return message;
    return { ...message, _modelCallDurationMs: durationMs };
  });
}

export function recordToDurationMap(record: Record<string, number> | undefined): Map<string, number> {
  return new Map(Object.entries(record ?? {}));
}
