/**
 * Parse assistant `usage` payloads the same way as Models token history
 * (`electron/utils/token-usage-core.ts`) so execution reporting matches UI.
 */

type UsageShape = Record<string, unknown> & {
  prompt_tokens_details?: unknown;
  cost?: { total?: unknown };
};

export interface ParsedUsageTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

function normalizeUsageNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function firstUsageNumber(usage: UsageShape | undefined, candidates: string[]): number | undefined {
  if (!usage) return undefined;
  for (const key of candidates) {
    const parsed = normalizeUsageNumber(usage[key]);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function cacheReadFromNestedUsage(usage: UsageShape): number | undefined {
  const details = usage.prompt_tokens_details;
  if (!details || typeof details !== 'object' || Array.isArray(details)) return undefined;
  return firstUsageNumber(details as UsageShape, [
    'cached_tokens',
    'cachedTokens',
    'cache_read',
    'cacheRead',
  ]);
}

/** Returns null when the message carries no usage block at all. */
export function parseUsageTokensFromShape(usage: unknown): ParsedUsageTokens | null {
  if (usage === undefined) return null;
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) {
    return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  }

  const usageShape = usage as UsageShape;
  const inputTokens = firstUsageNumber(usageShape, [
    'input',
    'promptTokens',
    'prompt_tokens',
    'input_tokens',
    'inputTokens',
    'inputTokenCount',
    'input_token_count',
    'promptTokenCount',
    'prompt_token_count',
  ]) ?? 0;
  const outputTokens = firstUsageNumber(usageShape, [
    'output',
    'completionTokens',
    'completion_tokens',
    'output_tokens',
    'outputTokens',
    'outputTokenCount',
    'output_token_count',
    'completionTokenCount',
    'completion_token_count',
  ]) ?? 0;
  const cacheReadTokens = firstUsageNumber(usageShape, [
    'cacheRead',
    'cache_read',
    'cacheReadTokens',
    'cache_read_tokens',
    'cacheReadTokenCount',
    'cache_read_token_count',
  ]) ?? cacheReadFromNestedUsage(usageShape) ?? 0;

  const hasUsageValue =
    firstUsageNumber(usageShape, [
      'input',
      'promptTokens',
      'prompt_tokens',
      'input_tokens',
      'inputTokens',
      'inputTokenCount',
      'input_token_count',
      'promptTokenCount',
      'prompt_token_count',
      'output',
      'completionTokens',
      'completion_tokens',
      'output_tokens',
      'outputTokens',
      'outputTokenCount',
      'output_token_count',
      'completionTokenCount',
      'completion_token_count',
      'cacheRead',
      'cache_read',
      'cacheReadTokens',
      'cache_read_tokens',
      'cacheReadTokenCount',
      'cache_read_token_count',
      'total',
      'totalTokens',
      'total_tokens',
      'totalTokenCount',
      'total_token_count',
    ]) !== undefined
    || cacheReadFromNestedUsage(usageShape) !== undefined
    || normalizeUsageNumber(usageShape.cost?.total) !== undefined;

  if (!hasUsageValue) return null;

  return {
    inputTokens: Math.max(0, Math.floor(inputTokens)),
    outputTokens: Math.max(0, Math.floor(outputTokens)),
    cacheReadTokens: Math.max(0, Math.floor(cacheReadTokens)),
  };
}

export function extractUsageTokensFromMessage(message: unknown): ParsedUsageTokens | null {
  if (!message || typeof message !== 'object') return null;
  const record = message as Record<string, unknown>;
  const direct = parseUsageTokensFromShape(record.usage);
  if (direct) return direct;
  const details = record.details;
  if (details && typeof details === 'object' && !Array.isArray(details)) {
    return parseUsageTokensFromShape((details as Record<string, unknown>).usage);
  }
  return null;
}
