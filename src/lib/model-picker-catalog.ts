import { LY_AUTO_PROVIDER_ID } from '@/lib/providers';

export interface ModelPickerCatalogEntry {
  titleKey: string;
  descriptionKey: string;
  contextWindow: number;
  supportsImageInput: boolean;
  supportsReasoning: boolean;
}

export const MODEL_PICKER_CATALOG: Record<string, ModelPickerCatalogEntry> = {
  [LY_AUTO_PROVIDER_ID]: {
    titleKey: 'composer.modelCatalog.lyAuto.title',
    descriptionKey: 'composer.modelCatalog.lyAuto.description',
    contextWindow: 100_000,
    supportsImageInput: true,
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
