import { useEffect, useRef, useState } from 'react';
import { useMinLoading } from './use-min-loading';

/** Match the default history loading overlay minimum duration. */
const SESSION_SWITCH_LOADING_MS = 500;

/**
 * Shows the same brief loading overlay used for history loads when the user
 * switches sessions. UI-only — store load/history behavior is unchanged.
 */
export function useSessionSwitchLoadingOverlay(sessionKey: string): boolean {
  const [active, setActive] = useState(false);
  const previousKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (previousKeyRef.current === null) {
      previousKeyRef.current = sessionKey;
      return;
    }
    if (previousKeyRef.current === sessionKey) return;

    previousKeyRef.current = sessionKey;
    setActive(true);
    const resetTimer = window.setTimeout(() => setActive(false), 0);
    return () => clearTimeout(resetTimer);
  }, [sessionKey]);

  return useMinLoading(active, SESSION_SWITCH_LOADING_MS);
}
