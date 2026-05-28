import {
  LY_DEEPSEEK_PROVIDER_ID,
  LY_MINIMAX_PROVIDER_ID,
  LY_QWEN_PROVIDER_ID,
} from '@/lib/providers';

export interface ModelPickerCatalogEntry {
  titleKey: string;
  descriptionKey: string;
  contextWindow: number;
  supportsImageInput: boolean;
  supportsReasoning: boolean;
}

export const MODEL_PICKER_CATALOG: Record<string, ModelPickerCatalogEntry> = {
  [LY_MINIMAX_PROVIDER_ID]: {
    titleKey: 'composer.modelCatalog.lyMinimax.title',
    descriptionKey: 'composer.modelCatalog.lyMinimax.description',
    contextWindow: 204_800,
    supportsImageInput: false,
    supportsReasoning: false,
  },
  [LY_QWEN_PROVIDER_ID]: {
    titleKey: 'composer.modelCatalog.lyQwen.title',
    descriptionKey: 'composer.modelCatalog.lyQwen.description',
    contextWindow: 262_144,
    supportsImageInput: true,
    supportsReasoning: true,
  },
  [LY_DEEPSEEK_PROVIDER_ID]: {
    titleKey: 'composer.modelCatalog.lyDeepseek.title',
    descriptionKey: 'composer.modelCatalog.lyDeepseek.description',
    contextWindow: 1_000_000,
    supportsImageInput: false,
    supportsReasoning: true,
  },
};

export function resolveModelPickerCatalog(vendorId: string): ModelPickerCatalogEntry | null {
  return MODEL_PICKER_CATALOG[vendorId] ?? null;
}

export function formatContextWindowTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
  }
  if (tokens >= 1_000) {
    return `${Math.round(tokens / 1_000)}K`;
  }
  return String(tokens);
}
