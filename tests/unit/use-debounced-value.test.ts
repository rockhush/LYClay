import { describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDebouncedValue } from '../../src/lib/use-debounced-value';

describe('useDebouncedValue', () => {
  it('updates debounced value after delay', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ value, delayMs }) => useDebouncedValue(value, delayMs),
      { initialProps: { value: 'alpha', delayMs: 200 } },
    );

    expect(result.current).toBe('alpha');
    rerender({ value: 'beta', delayMs: 200 });
    expect(result.current).toBe('alpha');

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current).toBe('beta');

    vi.useRealTimers();
  });
});
