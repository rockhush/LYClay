import { describe, expect, it, vi } from 'vitest';
import { shouldContinueBackendPolling } from '../../src/stores/chat/session-backend-bridge';
import type { ChatState } from '../../src/stores/chat/types';
import {
  _resetUserAbortedSessionsForTests,
  persistUserAbortedSession,
} from '../../src/stores/chat/user-aborted-sessions';

vi.mock('@/stores/gateway', () => ({
  useGatewayStore: {
    getState: () => ({ status: { state: 'running' } }),
  },
}));

function baseState(overrides: Partial<ChatState> = {}): ChatState {
  return {
    currentSessionKey: 'agent:main:session-1',
    sending: false,
    activeRunId: null,
    pendingFinal: false,
    messages: [],
    sessionBackendActivity: null,
    gatewayBackgroundActivity: null,
    sessionStreamingStates: {},
    emptyFinalRecovery: { status: 'idle' },
    ...overrides,
  } as ChatState;
}

describe('session-backend-bridge reconcile', () => {
  it('schedules reconcile while gateway tracks a strong user run', () => {
    expect(shouldContinueBackendPolling(baseState({
      sessionBackendActivity: {
        sessionKey: 'agent:main:session-1',
        status: 'processing',
        processing: true,
        hasTrackedUserRun: true,
        activeRunIds: ['run-1'],
      },
    }), 'agent:main:session-1')).toBe(true);
  });

  it('does not schedule reconcile for weak disk processing alone', () => {
    expect(shouldContinueBackendPolling(baseState({
      sessionBackendActivity: {
        sessionKey: 'agent:main:session-1',
        status: 'processing',
        processing: true,
        hasTrackedUserRun: false,
        activeRunIds: [],
      },
    }), 'agent:main:session-1')).toBe(false);
  });

  it('continues reconcile while this session child is in processingSessionKeys', () => {
    expect(shouldContinueBackendPolling(baseState({
      messages: [
        { role: 'user', content: 'go', timestamp: 1000 },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'spawn-1', name: 'sessions_spawn', input: {} }],
        },
        {
          role: 'toolResult',
          toolCallId: 'spawn-1',
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'accepted',
              childSessionKey: 'agent:main:session-2',
              runId: 'child-run',
            }),
          }],
        },
      ],
      gatewayBackgroundActivity: {
        hasBackgroundProcessing: true,
        processingSessionKeys: ['agent:main:session-2'],
      },
    }), 'agent:main:session-1')).toBe(true);
  });

  it('does not schedule reconcile for unrelated processingSessionKeys', () => {
    expect(shouldContinueBackendPolling(baseState({
      gatewayBackgroundActivity: {
        hasBackgroundProcessing: true,
        processingSessionKeys: ['agent:main:session-2'],
      },
    }), 'agent:main:session-1')).toBe(false);
  });

  it('stops reconcile when local and gateway signals are idle', () => {
    expect(shouldContinueBackendPolling(baseState(), 'agent:main:session-1')).toBe(false);
  });

  it('keeps reconcile for user-aborted sessions only while backend work remains', () => {
    persistUserAbortedSession('agent:main:session-1', 'run-1');
    expect(shouldContinueBackendPolling(baseState({
      sessionBackendActivity: {
        sessionKey: 'agent:main:session-1',
        status: 'running',
        processing: true,
        hasTrackedUserRun: true,
        activeRunIds: ['run-1'],
      },
    }), 'agent:main:session-1')).toBe(true);
    expect(shouldContinueBackendPolling(baseState({
      sessionBackendActivity: {
        sessionKey: 'agent:main:session-1',
        status: 'idle',
        processing: false,
        hasTrackedUserRun: false,
        activeRunIds: [],
      },
    }), 'agent:main:session-1')).toBe(false);
    _resetUserAbortedSessionsForTests();
  });
});
