import type { ChatGet, ChatSet, RuntimeActions } from './store-api';
import type { ReasoningMode } from './types';
import { invokeIpc } from '@/lib/api-client';

const SESSION_REASONING_MODES_STORAGE_KEY = 'LYClaw:chat:session-reasoning-modes';

function persistSessionReasoningModes(modes: Record<string, ReasoningMode>): void {
  try {
    window.localStorage.setItem(SESSION_REASONING_MODES_STORAGE_KEY, JSON.stringify(modes));
  } catch {
    // Ignore storage failures.
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
      const sessionKey = get().currentSessionKey;
      set((s) => {
        const nextModes = { ...s.sessionReasoningModes, [sessionKey]: mode };
        persistSessionReasoningModes(nextModes);
        return {
          reasoningMode: mode,
          thinkingLevel: toThinkingLevel(mode),
          sessionReasoningModes: nextModes,
        };
      });
      void patchSessionThinkingLevel(sessionKey, mode).catch((error) => {
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
