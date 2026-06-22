import { describe, expect, it } from 'vitest';
import { DEFAULT_CONTEXT_WINDOW, resolveContextBudget } from '@/stores/chat/context-budget';

function expectCloseTo(value: number, expected: number, tolerance: number) {
  expect(Math.abs(value - expected)).toBeLessThanOrEqual(tolerance);
}

describe('resolveContextBudget', () => {
  it('uses dynamic budget for 130K context windows', () => {
    const budget = resolveContextBudget(130000);

    expect(budget.contextWindow).toBe(130000);
    expect(budget.reservedOutputTokens).toBe(10400);
    expect(budget.reservedSystemTokens).toBe(10400);
    expect(budget.reservedToolTokens).toBe(7800);
    expect(budget.maxInputTokens).toBe(101400);
    expectCloseTo(budget.compressionTriggerTokens, 91260, 1);
    expect(budget.compressionTriggerTokens).toBeLessThan(150000);
    expect(budget.hardLimitTokens).toBe(Math.floor(budget.maxInputTokens * 0.99));
  });

  it('scales for 200K context windows', () => {
    const budget = resolveContextBudget(200000);

    expect(budget.contextWindow).toBe(200000);
    expect(budget.maxInputTokens).toBe(156000);
    expectCloseTo(budget.compressionTriggerTokens, 140400, 1);
    expect(budget.hardLimitTokens).toBe(Math.floor(budget.maxInputTokens * 0.99));
  });

  it('stays conservative for 32K context windows', () => {
    const budget = resolveContextBudget(32000);

    expect(budget.contextWindow).toBe(32000);
    expect(budget.compressionTriggerTokens).toBeGreaterThanOrEqual(13800);
    expect(budget.compressionTriggerTokens).toBeLessThanOrEqual(18000);
    expect(budget.hardLimitTokens).toBeLessThan(budget.maxInputTokens);
  });

  it('falls back to the default context window for invalid values', () => {
    expect(resolveContextBudget(null).contextWindow).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(resolveContextBudget(undefined).contextWindow).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(resolveContextBudget(0).contextWindow).toBe(DEFAULT_CONTEXT_WINDOW);
  });
});
