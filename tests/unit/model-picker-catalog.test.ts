import { describe, expect, it } from 'vitest';
import {
  formatContextWindowTokens,
  resolveModelPickerCatalog,
} from '../../src/lib/model-picker-catalog';

describe('model-picker-catalog', () => {
  it('resolves built-in LY provider metadata', () => {
    expect(resolveModelPickerCatalog('ly-qwen')?.contextWindow).toBe(262_144);
    expect(resolveModelPickerCatalog('ly-deepseek')?.contextWindow).toBe(1_000_000);
    expect(resolveModelPickerCatalog('ly-minimax')?.contextWindow).toBe(204_800);
    expect(resolveModelPickerCatalog('ly-deepseek')?.supportsReasoning).toBe(true);
  });

  it('formats context window labels', () => {
    expect(formatContextWindowTokens(204_800)).toBe('205K');
    expect(formatContextWindowTokens(1_048_576)).toBe('1M');
  });
});
