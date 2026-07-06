import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawMessage } from '@/stores/chat/types';

vi.mock('@/lib/host-api', () => ({
  getEmptyFinalDiagnostic: vi.fn(),
}));

vi.mock('@/stores/chat/finalize-turn-bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/chat/finalize-turn-bridge')>();
  return {
    ...actual,
    deferClearUserTurnForOpenDelegation: vi.fn(() => true),
  };
});

import { getEmptyFinalDiagnostic } from '@/lib/host-api';
import { deferClearUserTurnForOpenDelegation } from '@/stores/chat/finalize-turn-bridge';
import {
  confirmEmptyFinalWithHistory,
  shouldDeferEmptyFinalForOpenDelegation,
} from '@/stores/chat/empty-final-recovery';

const childKey = 'agent:main:subagent:child-1';

function spawnAssistantMessage(): RawMessage {
  return {
    role: 'assistant',
    content: [{
      type: 'toolCall',
      id: 'call_spawn',
      name: 'sessions_spawn',
      input: { taskName: 'ppt-generation', runtime: 'subagent' },
    }],
  };
}

function spawnResultMessage(): RawMessage {
  return {
    role: 'toolresult',
    toolCallId: 'call_spawn',
    content: JSON.stringify({
      status: 'accepted',
      childSessionKey: childKey,
      runId: 'child-run-1',
      taskName: 'ppt-generation',
    }),
  };
}

describe('empty-final-recovery delegation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(deferClearUserTurnForOpenDelegation).mockReturnValue(true);
  });

  it('shouldDeferEmptyFinalForOpenDelegation when child is still processing', () => {
    const state = {
      currentSessionKey: 'agent:main:main',
      messages: [{ role: 'user', content: 'task', timestamp: 1 }, spawnAssistantMessage(), spawnResultMessage()],
      gatewayBackgroundActivity: { processingSessionKeys: [childKey] },
      sessionBackendActivity: null,
      lastUserMessageAt: 1,
      streamingMessage: null,
    } as never;

    expect(shouldDeferEmptyFinalForOpenDelegation(state)).toBe(true);
  });

  it('defers bare final instead of marking stale when delegation is open', async () => {
    vi.useFakeTimers();
    const loadHistory = vi.fn(async () => undefined);
    const state: Record<string, unknown> = {
      currentSessionKey: 'agent:main:main',
      messages: [{ role: 'user', content: 'task', timestamp: 1 }, spawnAssistantMessage(), spawnResultMessage()],
      sessionStreamingStates: {},
      sending: true,
      activeRunId: 'run-yield-final',
      streamingText: '',
      streamingMessage: null,
      streamingTools: [{ id: 'call_spawn', name: 'sessions_spawn', status: 'completed' }],
      pendingFinal: false,
      lastUserMessageAt: 1,
      pendingToolImages: [],
      error: null,
      runError: null,
      emptyFinalRecovery: { status: 'idle' },
      gatewayBackgroundActivity: { processingSessionKeys: [childKey] },
      sessionBackendActivity: { hasTrackedUserRun: false, processing: false },
      loadHistory,
    };
    const set = (patch: Record<string, unknown> | ((s: Record<string, unknown>) => Record<string, unknown>)) => {
      Object.assign(state, typeof patch === 'function' ? patch(state) : patch);
    };
    const get = () => state as never;

    await confirmEmptyFinalWithHistory(set as never, get, 'run-yield-final');

    expect(deferClearUserTurnForOpenDelegation).toHaveBeenCalled();
    expect(state.emptyFinalRecovery).toMatchObject({ status: 'idle' });
    expect(state.runError).toBeNull();
    expect(getEmptyFinalDiagnostic).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('still surfaces stale recovery for genuine empty finals without delegation', async () => {
    vi.useFakeTimers();
    vi.mocked(deferClearUserTurnForOpenDelegation).mockReturnValue(false);
    vi.mocked(getEmptyFinalDiagnostic).mockResolvedValue({
      success: true,
      diagnostic: {
        recoveryResult: { recovered: false, reason: 'lock-owned-by-other-process' },
      },
      hasTrackedActiveRun: false,
    });

    const loadHistory = vi.fn(async () => undefined);
    const state: Record<string, unknown> = {
      currentSessionKey: 'agent:main:main',
      messages: [{ role: 'user', content: 'Question', timestamp: 123 }],
      sessionStreamingStates: {},
      sending: true,
      activeRunId: 'run-empty-final',
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: true,
      lastUserMessageAt: 123,
      pendingToolImages: [],
      error: null,
      runError: null,
      emptyFinalRecovery: { status: 'idle' },
      gatewayBackgroundActivity: { processingSessionKeys: [] },
      sessionBackendActivity: null,
      loadHistory,
    };
    const set = (patch: Record<string, unknown> | ((s: Record<string, unknown>) => Record<string, unknown>)) => {
      Object.assign(state, typeof patch === 'function' ? patch(state) : patch);
    };
    const get = () => state as never;

    const promise = confirmEmptyFinalWithHistory(set as never, get, 'run-empty-final');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_000);
    await promise;

    expect(state.emptyFinalRecovery).toMatchObject({
      status: 'stale',
      reason: 'lock-owned-by-other-process',
    });
    expect(String(state.runError)).toContain('Run ended without a response');
    vi.useRealTimers();
  });
});
