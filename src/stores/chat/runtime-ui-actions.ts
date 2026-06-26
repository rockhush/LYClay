import type { ChatGet, ChatSet, RuntimeActions } from './store-api';
import type { ReasoningMode } from './types';
import { invokeIpc } from '@/lib/api-client';

const REASONING_MODE_STORAGE_KEY = 'LYClaw:chat:reasoning-mode';

function persistReasoningMode(mode: ReasoningMode): void {
  try {
    window.localStorage.setItem(REASONING_MODE_STORAGE_KEY, mode);
  } catch {
    // Ignore storage failures; the current session still updates in memory.
  }
}

function toThinkingLevel(mode: ReasoningMode): 'off' | 'medium' {
  return mode === 'fast' ? 'off' : 'medium';
}

async function patchSessionThinkingLevel(sessionKey: string, mode: ReasoningMode): Promise<void> {
  const result = await invokeIpc(
    'gateway:rpc',
    'sessions.patch',
    {
      key: sessionKey,
      thinkingLevel: toThinkingLevel(mode),
    },
    5_000,
  ) as { success?: boolean; error?: string };

  if (result && result.success === false) {
    throw new Error(result.error || 'Failed to update thinking level');
  }
}

export function createRuntimeUiActions(set: ChatSet, get: ChatGet): Pick<RuntimeActions, 'setReasoningMode' | 'refresh' | 'clearError'> {
  return {
    setReasoningMode: async (mode) => {
      persistReasoningMode(mode);
      set({ reasoningMode: mode, thinkingLevel: toThinkingLevel(mode) });
      void patchSessionThinkingLevel(get().currentSessionKey, mode).catch((error) => {
        console.warn('[chat] Failed to persist thinking level; continuing with one-shot /think directive:', error);
      });
    },

    // ── Refresh: reload history + sessions ──

    refresh: async () => {
      const { loadHistory, loadSessions } = get();
      await Promise.all([loadHistory(), loadSessions()]);
    },

    clearError: () => set({ error: null }),
  };
}
