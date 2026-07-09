import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSessionSwitchLoadingOverlay } from '@/hooks/use-session-switch-loading-overlay';

describe('useSessionSwitchLoadingOverlay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not show on initial mount', () => {
    const { result } = renderHook(({ key }) => useSessionSwitchLoadingOverlay(key), {
      initialProps: { key: 'agent:main:session-a' },
    });

    expect(result.current).toBe(false);
  });

  it('shows for at least 500ms after session key changes', () => {
    const { result, rerender } = renderHook(({ key }) => useSessionSwitchLoadingOverlay(key), {
      initialProps: { key: 'agent:main:session-a' },
    });

    rerender({ key: 'agent:main:session-b' });

    act(() => {
      vi.runOnlyPendingTimers();
    });
    expect(result.current).toBe(true);

    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(result.current).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(false);
  });
});
