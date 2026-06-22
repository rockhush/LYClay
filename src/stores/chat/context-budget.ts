export interface ContextBudget {
  contextWindow: number;
  maxInputTokens: number;
  compressionTriggerTokens: number;
  reservedOutputTokens: number;
  reservedSystemTokens: number;
  reservedToolTokens: number;
  recentRawTokens: number;
  summaryTokens: number;
  hardLimitTokens: number;
  maxSingleMessageTokens: number;
}

export interface ContextBudgetOptions {
  compressionTriggerRatio?: number;
  recentRawRatio?: number;
  summaryRatio?: number;
  hardLimitRatio?: number;
  maxSingleMessageRatio?: number;
}

export const DEFAULT_CONTEXT_WINDOW = 128000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function normalizeContextWindow(contextWindow: number | null | undefined): number {
  if (typeof contextWindow === 'number' && Number.isFinite(contextWindow) && contextWindow > 0) {
    return Math.floor(contextWindow);
  }
  return DEFAULT_CONTEXT_WINDOW;
}

export function resolveContextBudget(
  contextWindowInput: number | null | undefined,
  options: ContextBudgetOptions = {},
): ContextBudget {
  const contextWindow = normalizeContextWindow(contextWindowInput);
  const compressionTriggerRatio = options.compressionTriggerRatio ?? 0.90;
  const recentRawRatio = options.recentRawRatio ?? 0.35;
  const summaryRatio = options.summaryRatio ?? 0.12;
  const hardLimitRatio = options.hardLimitRatio ?? 0.99;
  const maxSingleMessageRatio = options.maxSingleMessageRatio ?? 0.18;

  const reservedOutputTokens = clamp(Math.floor(contextWindow * 0.08), 4096, 32000);
  const reservedSystemTokens = clamp(Math.floor(contextWindow * 0.08), 4000, 24000);
  const reservedToolTokens = clamp(Math.floor(contextWindow * 0.06), 4000, 20000);
  const maxInputTokens = Math.max(1024, contextWindow - reservedOutputTokens - reservedSystemTokens - reservedToolTokens);

  return {
    contextWindow,
    maxInputTokens,
    reservedOutputTokens,
    reservedSystemTokens,
    reservedToolTokens,
    compressionTriggerTokens: Math.floor(maxInputTokens * compressionTriggerRatio),
    recentRawTokens: clamp(Math.floor(maxInputTokens * recentRawRatio), 12000, 80000),
    summaryTokens: clamp(Math.floor(maxInputTokens * summaryRatio), 2000, 20000),
    hardLimitTokens: Math.floor(maxInputTokens * hardLimitRatio),
    maxSingleMessageTokens: Math.floor(maxInputTokens * maxSingleMessageRatio),
  };
}
