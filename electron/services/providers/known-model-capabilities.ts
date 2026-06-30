import {
  resolveMaxTokensFieldForBaseUrl,
  type OpenClawMaxTokensField,
} from './openclaw-endpoint-compat';

/** DeepSeek V4 official limits (1M context, 384K max output per API docs). */
export const DEEPSEEK_V4_CONTEXT_WINDOW = 1_048_576;
export const DEEPSEEK_V4_MAX_OUTPUT_TOKENS = 384_000;

/** OpenClaw models.json schema only allows text and image modalities. */
export const OPENCLAW_ALLOWED_MODEL_INPUTS = ['text', 'image'] as const;
export type OpenClawModelInput = typeof OPENCLAW_ALLOWED_MODEL_INPUTS[number];

const DEEPSEEK_V4_MODEL_SUFFIXES = ['deepseek-v4-pro', 'deepseek-v4-flash'] as const;

export type SyncOpenClawModelCatalogOptions = {
  baseUrl?: string;
};

/**
 * Strip unsupported modalities (e.g. nginx "video") so models.json passes OpenClaw validation.
 * A single invalid model row rejects the entire file, which drops custom provider entries too.
 */
export function sanitizeOpenClawModelInput(input: unknown): OpenClawModelInput[] {
  if (!Array.isArray(input)) {
    return ['text'];
  }
  const filtered = input.filter((item): item is OpenClawModelInput => item === 'text' || item === 'image');
  return filtered.length > 0 ? filtered : ['text'];
}

export function sanitizeOpenClawModelEntry(modelEntry: Record<string, unknown>): Record<string, unknown> {
  if (!('input' in modelEntry)) {
    return modelEntry;
  }
  const sanitizedInput = sanitizeOpenClawModelInput(modelEntry.input);
  const current = modelEntry.input;
  if (Array.isArray(current)
    && current.length === sanitizedInput.length
    && current.every((item, index) => item === sanitizedInput[index])) {
    return modelEntry;
  }
  return {
    ...modelEntry,
    input: sanitizedInput,
  };
}

export function isDeepSeekV4ModelId(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  if (DEEPSEEK_V4_MODEL_SUFFIXES.includes(normalized as typeof DEEPSEEK_V4_MODEL_SUFFIXES[number])) {
    return true;
  }
  return DEEPSEEK_V4_MODEL_SUFFIXES.some((suffix) => normalized.endsWith(`/${suffix}`));
}

function readCompatRecord(modelEntry: Record<string, unknown>): Record<string, unknown> {
  const existingCompat = modelEntry.compat;
  if (existingCompat && typeof existingCompat === 'object' && !Array.isArray(existingCompat)) {
    return existingCompat as Record<string, unknown>;
  }
  return {};
}

function mergeCompatField(
  modelEntry: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const compatBase = readCompatRecord(modelEntry);
  const nextCompat = { ...compatBase, ...patch };
  if (Object.keys(nextCompat).length === 0) {
    return modelEntry;
  }
  const unchanged = Object.entries(patch).every(([key, value]) => compatBase[key] === value);
  if (unchanged) {
    return modelEntry;
  }
  return {
    ...modelEntry,
    compat: nextCompat,
  };
}

/** Keep contextTokens in sync with contextWindow so OpenClaw transport clamping uses the full window. */
export function alignContextTokensWithWindow(modelEntry: Record<string, unknown>): Record<string, unknown> {
  const contextWindow = typeof modelEntry.contextWindow === 'number' ? modelEntry.contextWindow : undefined;
  if (contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return modelEntry;
  }
  const contextTokens = typeof modelEntry.contextTokens === 'number' ? modelEntry.contextTokens : undefined;
  if (contextTokens !== undefined && contextTokens >= contextWindow) {
    return modelEntry;
  }
  return {
    ...modelEntry,
    contextTokens: contextWindow,
  };
}

/** Pick max_tokens vs max_completion_tokens from the provider base URL (all custom providers). */
export function applyEndpointMaxTokensFieldCompat(
  modelEntry: Record<string, unknown>,
  baseUrl?: string,
): Record<string, unknown> {
  const maxTokensField: OpenClawMaxTokensField = resolveMaxTokensFieldForBaseUrl(baseUrl);
  return mergeCompatField(modelEntry, { maxTokensField });
}

function applyKnownModelCatalogLimits(
  modelId: string,
  modelEntry: Record<string, unknown>,
): Record<string, unknown> {
  if (!isDeepSeekV4ModelId(modelId)) {
    return modelEntry;
  }

  return {
    ...modelEntry,
    contextWindow: DEEPSEEK_V4_CONTEXT_WINDOW,
    contextTokens: DEEPSEEK_V4_CONTEXT_WINDOW,
    maxTokens: DEEPSEEK_V4_MAX_OUTPUT_TOKENS,
  };
}

/**
 * Normalize a model catalog row before writing openclaw.json / agent models.json.
 * Applies to every provider (custom, ly-auto, built-in sync paths) — not DeepSeek-only.
 */
export function syncOpenClawModelCatalogEntry(
  modelId: string,
  modelEntry: Record<string, unknown>,
  options: SyncOpenClawModelCatalogOptions = {},
): Record<string, unknown> {
  let entry = sanitizeOpenClawModelEntry(modelEntry);
  entry = alignContextTokensWithWindow(entry);
  entry = applyEndpointMaxTokensFieldCompat(entry, options.baseUrl);
  entry = applyKnownModelCatalogLimits(modelId, entry);
  // Re-align after catalog limits may have raised contextWindow.
  entry = alignContextTokensWithWindow(entry);
  entry = applyEndpointMaxTokensFieldCompat(entry, options.baseUrl);
  return entry;
}

/**
 * @deprecated Prefer syncOpenClawModelCatalogEntry with baseUrl when available.
 */
export function applyKnownModelCapabilityOverrides(
  modelId: string,
  modelEntry: Record<string, unknown>,
  baseUrl?: string,
): Record<string, unknown> {
  return syncOpenClawModelCatalogEntry(modelId, modelEntry, { baseUrl });
}
