import { describe, expect, it } from 'vitest';
import {
  clampExecutionFirstResponseMs,
  resolveExecutionReportModelId,
} from '../../shared/reporting/execution-report-fields';

describe('resolveExecutionReportModelId', () => {
  it('joins provider and bare model id', () => {
    expect(resolveExecutionReportModelId('auto', 'ly-auto')).toBe('ly-auto/auto');
  });

  it('keeps an already-qualified model ref', () => {
    expect(resolveExecutionReportModelId('ly-auto/auto', 'ignored')).toBe('ly-auto/auto');
  });

  it('maps bare auto to configured fallback ref', () => {
    expect(resolveExecutionReportModelId('auto', undefined, 'ly-auto/auto')).toBe('ly-auto/auto');
  });

  it('keeps unrelated bare model ids when no provider is available', () => {
    expect(resolveExecutionReportModelId('claude-sonnet-4', undefined, 'ly-auto/auto'))
      .toBe('claude-sonnet-4');
  });
});

describe('clampExecutionFirstResponseMs', () => {
  it('caps first response to turn duration', () => {
    const started = 1_000;
    const ended = 1_000 + 108_000;
    expect(clampExecutionFirstResponseMs(85_443, started, ended)).toBe(85_443);
    expect(clampExecutionFirstResponseMs(120_000, started, ended)).toBe(108_000);
  });

  it('returns undefined for invalid values', () => {
    expect(clampExecutionFirstResponseMs(undefined, 1, 2)).toBeUndefined();
    expect(clampExecutionFirstResponseMs(Number.NaN, 1, 2)).toBeUndefined();
  });
});
