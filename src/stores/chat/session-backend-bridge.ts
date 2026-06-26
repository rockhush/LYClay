import { getSessionBackendActivity } from '@/lib/host-api';
import { isWaitingOnSubagentDelegation } from '@/lib/subagent-delegation';
import type { ChatState } from './types';
import {
  buildReAdoptRunPatch,
  isBackendSessionActive,
  type GatewayBackgroundActivity,
  type SessionBackendActivity,
} from './user-turn-lifecycle';

const SESSION_ACTIVITY_POLL_MS = 4_000;

let _pollTimer: ReturnType<typeof setTimeout> | null = null;
let _pollSessionKey: string | null = null;

export function clearSessionActivityPoll(): void {
  if (_pollTimer) {
    clearTimeout(_pollTimer);
    _pollTimer = null;
  }
  _pollSessionKey = null;
}

export async function refreshSessionBackendActivity(
  sessionKey: string,
): Promise<{ session: SessionBackendActivity; background: GatewayBackgroundActivity } | null> {
  try {
    const response = await getSessionBackendActivity(sessionKey);
    if (!response.success) return null;
    return {
      session: response.session,
      background: response.background,
    };
  } catch (error) {
    console.warn('[chat.session-activity] refresh failed', { sessionKey, error: String(error) });
    return null;
  }
}

export function startSessionActivityPoll(
  sessionKey: string,
  apply: (partial: Partial<ChatState>) => void,
  getState: () => ChatState,
): void {
  clearSessionActivityPoll();
  _pollSessionKey = sessionKey;

  const tick = async () => {
    if (_pollSessionKey !== sessionKey) return;

    const state = getState();
    const shouldPoll = state.currentSessionKey === sessionKey && (
      state.sending
      || state.pendingFinal
      || Boolean(state.activeRunId)
      || state.emptyFinalRecovery.status === 'waiting'
      || state.emptyFinalRecovery.status === 'checking'
      || isWaitingOnSubagentDelegation(
        state.messages,
        state.gatewayBackgroundActivity?.processingSessionKeys ?? [],
      )
      || Boolean(state.gatewayBackgroundActivity?.hasBackgroundProcessing)
    );

    if (!shouldPoll) {
      clearSessionActivityPoll();
      return;
    }

    const snapshot = await refreshSessionBackendActivity(sessionKey);
    if (_pollSessionKey !== sessionKey || !snapshot) {
      scheduleNext();
      return;
    }

    const nextState = getState();
    if (nextState.currentSessionKey !== sessionKey) {
      clearSessionActivityPoll();
      return;
    }

    apply({
      sessionBackendActivity: snapshot.session,
      gatewayBackgroundActivity: snapshot.background,
    });

    const reAdopt = buildReAdoptRunPatch(
      { ...nextState, currentSessionKey: sessionKey },
      sessionKey,
      snapshot.session,
    );
    if (reAdopt) {
      apply(reAdopt);
    }

    scheduleNext();
  };

  const scheduleNext = () => {
    if (_pollSessionKey !== sessionKey) return;
    _pollTimer = setTimeout(() => {
      void tick();
    }, SESSION_ACTIVITY_POLL_MS);
  };

  void tick();
}

export function isSessionStillProcessingOnBackend(
  activity: SessionBackendActivity | null | undefined,
): boolean {
  return isBackendSessionActive(activity);
}
