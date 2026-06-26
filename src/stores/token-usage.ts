import { create } from 'zustand';
import { hostApiFetch } from '@/lib/host-api';
import { trackUiEvent } from '@/lib/telemetry';
import {
  resolveStableUsageHistory,
  type UsageHistoryEntry,
} from '@/pages/Models/usage-history';

const DEFAULT_USAGE_FETCH_MAX_ATTEMPTS = 2;
const WINDOWS_USAGE_FETCH_MAX_ATTEMPTS = 3;
const USAGE_FETCH_RETRY_DELAY_MS = 1500;

function resolveUsageFetchMaxAttempts(): number {
  if (typeof window !== 'undefined' && window.electron?.platform === 'win32') {
    return WINDOWS_USAGE_FETCH_MAX_ATTEMPTS;
  }
  return DEFAULT_USAGE_FETCH_MAX_ATTEMPTS;
}

interface TokenUsageState {
  status: 'idle' | 'loading' | 'done';
  entries: UsageHistoryEntry[];
  stableEntries: UsageHistoryEntry[];
  loaded: boolean;
  fetchTokenUsageHistory: (options?: { force?: boolean }) => Promise<void>;
}

let fetchTokenUsagePromise: Promise<void> | null = null;
let fetchGeneration = 0;
let fetchTimer: ReturnType<typeof setTimeout> | null = null;

function clearFetchTimer(): void {
  if (fetchTimer) {
    clearTimeout(fetchTimer);
    fetchTimer = null;
  }
}

export const useTokenUsageStore = create<TokenUsageState>((set, get) => ({
  status: 'idle',
  entries: [],
  stableEntries: [],
  loaded: false,

  fetchTokenUsageHistory: async (options) => {
    if (fetchTokenUsagePromise) {
      return fetchTokenUsagePromise;
    }
    if (!options?.force && get().loaded) {
      return;
    }

    fetchTokenUsagePromise = (async () => {
      clearFetchTimer();
      set({ status: 'loading' });
      const generation = fetchGeneration + 1;
      fetchGeneration = generation;
      const usageFetchMaxAttempts = resolveUsageFetchMaxAttempts();
      trackUiEvent('models.token_usage_fetch_started', { generation });

      const safetyTimeout = setTimeout(() => {
        if (fetchGeneration !== generation) return;
        trackUiEvent('models.token_usage_fetch_safety_timeout', { generation });
        set((state) => ({
          status: 'done',
          stableEntries: resolveStableUsageHistory(state.stableEntries, state.entries, {
            preservePreviousOnEmpty: true,
          }),
        }));
      }, 30_000);

      const finish = (entries: UsageHistoryEntry[]) => {
        clearTimeout(safetyTimeout);
        set((state) => ({
          status: 'done',
          entries,
          stableEntries: resolveStableUsageHistory(state.stableEntries, entries),
          loaded: true,
        }));
      };

      const fail = () => {
        clearTimeout(safetyTimeout);
        set({ status: 'done' });
      };

      const fetchWithRetry = async (attempt: number): Promise<void> => {
        trackUiEvent('models.token_usage_fetch_attempt', { generation, attempt });
        try {
          const response = await hostApiFetch<UsageHistoryEntry[]>('/api/usage/recent-token-history');
          if (fetchGeneration !== generation) return;

          const normalized = Array.isArray(response) ? response : [];
          trackUiEvent('models.token_usage_fetch_succeeded', {
            generation,
            attempt,
            records: normalized.length,
          });

          if (normalized.length === 0 && attempt < usageFetchMaxAttempts) {
            trackUiEvent('models.token_usage_fetch_retry_scheduled', {
              generation,
              attempt,
              reason: 'empty',
            });
            await new Promise<void>((resolve) => {
              fetchTimer = setTimeout(resolve, USAGE_FETCH_RETRY_DELAY_MS);
            });
            if (fetchGeneration !== generation) return;
            await fetchWithRetry(attempt + 1);
            return;
          }

          if (normalized.length === 0) {
            trackUiEvent('models.token_usage_fetch_exhausted', {
              generation,
              attempt,
              reason: 'empty',
            });
          }
          finish(normalized);
        } catch (error) {
          if (fetchGeneration !== generation) return;
          trackUiEvent('models.token_usage_fetch_failed_attempt', {
            generation,
            attempt,
            message: error instanceof Error ? error.message : String(error),
          });
          if (attempt < usageFetchMaxAttempts) {
            trackUiEvent('models.token_usage_fetch_retry_scheduled', {
              generation,
              attempt,
              reason: 'error',
            });
            await new Promise<void>((resolve) => {
              fetchTimer = setTimeout(resolve, USAGE_FETCH_RETRY_DELAY_MS);
            });
            if (fetchGeneration !== generation) return;
            await fetchWithRetry(attempt + 1);
            return;
          }
          fail();
          trackUiEvent('models.token_usage_fetch_exhausted', {
            generation,
            attempt,
            reason: 'error',
          });
        }
      };

      try {
        await fetchWithRetry(1);
      } finally {
        clearFetchTimer();
        fetchTokenUsagePromise = null;
      }
    })();

    return fetchTokenUsagePromise;
  },
}));

const TOKEN_USAGE_POST_RUN_REFRESH_DELAY_MS = 2000;

/** Refresh token usage after a chat run so Models page picks up new JSONL records. */
export function scheduleTokenUsageRefreshAfterRun(): void {
  void useTokenUsageStore.getState().fetchTokenUsageHistory({ force: true });
  setTimeout(() => {
    void useTokenUsageStore.getState().fetchTokenUsageHistory({ force: true });
  }, TOKEN_USAGE_POST_RUN_REFRESH_DELAY_MS);
}

/** Test helper */
export function resetTokenUsageStoreForTests(): void {
  clearFetchTimer();
  fetchTokenUsagePromise = null;
  fetchGeneration = 0;
  useTokenUsageStore.setState({
    status: 'idle',
    entries: [],
    stableEntries: [],
    loaded: false,
  });
}
