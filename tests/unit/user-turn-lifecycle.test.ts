import { describe, expect, it } from 'vitest';
import {
  backendActivityForSession,
  buildReAdoptRunPatch,
  deriveHasActiveRunSignal,
  deriveIsExecuting,
  isBackendSessionActive,
  shouldFinalizeUserTurn,
  shouldForceAbortStuckRun,
} from '@/stores/chat/user-turn-lifecycle';
import type { RawMessage } from '@/stores/chat/types';

describe('user-turn-lifecycle', () => {
  const terminalAssistant: RawMessage = {
    role: 'assistant',
    content: 'done',
    stopReason: 'stop',
    timestamp: 2000,
  };

  const toolRoundAssistant: RawMessage = {
    role: 'assistant',
    content: [{ type: 'toolCall', id: 't1', name: 'read', arguments: {} }],
    stopReason: 'toolUse',
    timestamp: 2000,
  };

  it('treats backend processing as an open user turn', () => {
    expect(isBackendSessionActive({
      sessionKey: 'agent:main:session-1',
      status: 'processing',
      processing: true,
      hasTrackedUserRun: false,
      activeRunIds: [],
    })).toBe(true);
  });

  it('does not finalize while backend is still active', () => {
    const messages: RawMessage[] = [
      { role: 'user', content: 'question', timestamp: 1000 },
      terminalAssistant,
    ];
    expect(shouldFinalizeUserTurn(
      messages,
      1000,
      {
        sessionKey: 'agent:main:session-1',
        status: 'processing',
        processing: true,
        hasTrackedUserRun: true,
        activeRunIds: ['run-1'],
      },
      terminalAssistant,
    )).toBe(false);
  });

  it('finalizes when terminal assistant exists and backend is idle', () => {
    const messages: RawMessage[] = [
      { role: 'user', content: 'question', timestamp: 1000 },
      terminalAssistant,
    ];
    expect(shouldFinalizeUserTurn(messages, 1000, {
      sessionKey: 'agent:main:session-1',
      status: 'idle',
      processing: false,
      hasTrackedUserRun: false,
      activeRunIds: [],
    })).toBe(true);
  });

  it('keeps tool-round finals active even when backend is idle', () => {
    const messages: RawMessage[] = [
      { role: 'user', content: 'question', timestamp: 1000 },
      toolRoundAssistant,
    ];
    expect(shouldFinalizeUserTurn(messages, 1000, {
      sessionKey: 'agent:main:session-1',
      status: 'idle',
      processing: false,
      hasTrackedUserRun: false,
      activeRunIds: [],
    })).toBe(false);
  });

  it('re-adopts run state when UI cleared but backend still active', () => {
    expect(buildReAdoptRunPatch(
      {
        currentSessionKey: 'agent:main:session-1',
        sending: false,
        activeRunId: null,
        pendingFinal: false,
      },
      'agent:main:session-1',
      {
        sessionKey: 'agent:main:session-1',
        status: 'processing',
        processing: true,
        hasTrackedUserRun: true,
        activeRunIds: ['run-1'],
      },
    )).toEqual({
      sending: true,
      pendingFinal: true,
      activeRunId: 'run-1',
    });
  });

  it('derives executing from backend liveness without local signals', () => {
    expect(deriveHasActiveRunSignal(
      { sending: false, activeRunId: null, pendingFinal: false },
      {
        sessionKey: 'agent:main:session-1',
        status: 'processing',
        processing: true,
        hasTrackedUserRun: true,
        activeRunIds: ['run-1'],
      },
    )).toBe(true);
  });

  it('includes waiting-on-subagent in deriveIsExecuting', () => {
    expect(deriveIsExecuting(
      { sending: false, activeRunId: null, pendingFinal: false },
      null,
      { waitingOnSubagentDelegation: true },
    )).toBe(true);
  });

  it('does not treat other-session background activity as current-session executing', () => {
    expect(deriveIsExecuting(
      { sending: false, activeRunId: null, pendingFinal: false },
      null,
    )).toBe(false);
  });

  it('ignores backend activity when sessionKey mismatches', () => {
    expect(backendActivityForSession({
      sessionKey: 'agent:main:session-a',
      status: 'processing',
      processing: true,
      hasTrackedUserRun: true,
      activeRunIds: ['run-1'],
    }, 'agent:main:session-b')).toBeNull();
    expect(deriveIsExecuting(
      { sending: false, activeRunId: null, pendingFinal: false },
      backendActivityForSession({
        sessionKey: 'agent:main:session-a',
        status: 'processing',
        processing: true,
        hasTrackedUserRun: true,
        activeRunIds: ['run-1'],
      }, 'agent:main:session-b'),
    )).toBe(false);
  });

  it('uses backend activity when sessionKey matches', () => {
    expect(deriveIsExecuting(
      { sending: false, activeRunId: null, pendingFinal: false },
      backendActivityForSession({
        sessionKey: 'agent:main:session-1',
        status: 'processing',
        processing: true,
        hasTrackedUserRun: true,
        activeRunIds: ['run-1'],
      }, 'agent:main:session-1'),
    )).toBe(true);
  });

  it('does not finalize while waiting on an in-flight subagent delegation', () => {
    const messages: RawMessage[] = [
      { role: 'user', content: 'question', timestamp: 1000 },
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'spawn-1',
          name: 'sessions_spawn',
          input: { task: 'research' },
        }],
      },
      {
        role: 'toolResult',
        toolCallId: 'spawn-1',
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'accepted',
            childSessionKey: 'agent:main:subagent:child-123',
            runId: 'child-run',
          }),
        }],
      },
      terminalAssistant,
    ];
    expect(shouldFinalizeUserTurn(messages, 1000, {
      sessionKey: 'agent:main:session-1',
      status: 'idle',
      processing: false,
      hasTrackedUserRun: false,
      activeRunIds: [],
    })).toBe(false);
  });

  it('does not finalize while a completed spawn still processes on the gateway', () => {
    const messages: RawMessage[] = [
      { role: 'user', content: 'question', timestamp: 1000 },
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'spawn-1',
          name: 'sessions_spawn',
          input: { task: 'research' },
        }],
      },
      {
        role: 'toolResult',
        toolCallId: 'spawn-1',
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'accepted',
            childSessionKey: 'agent:main:subagent:child-123',
            runId: 'child-run',
          }),
        }],
      },
      {
        role: 'assistant',
        content: '[Internal task completion event]\nsession_key: agent:main:subagent:child-123\nsession_id: child-session-id',
        timestamp: 2500,
      },
      terminalAssistant,
    ];
    expect(shouldFinalizeUserTurn(
      messages,
      1000,
      {
        sessionKey: 'agent:main:session-1',
        status: 'idle',
        processing: false,
        hasTrackedUserRun: false,
        activeRunIds: [],
      },
      terminalAssistant,
      {
        hasBackgroundProcessing: true,
        processingSessionKeys: ['agent:main:subagent:child-123'],
      },
    )).toBe(false);
  });

  it('treats in-flight subagent delegation as an active run signal', () => {
    expect(deriveHasActiveRunSignal(
      { sending: false, activeRunId: null, pendingFinal: false },
      null,
      { waitingOnSubagentDelegation: true },
    )).toBe(true);
  });

  it('finalizes when a post-tool concluding reply exists and backend is idle', () => {
    const messages: RawMessage[] = [
      { role: 'user', content: 'question', timestamp: 1000 },
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 't1', name: 'write', arguments: {} }],
        stopReason: 'toolUse',
        timestamp: 2000,
      },
      { role: 'toolresult', toolCallId: 't1', content: 'ok', timestamp: 3000 },
      {
        role: 'assistant',
        content: [{ type: 'text', text: '文件已写好。' }],
        timestamp: 4000,
      },
    ];
    expect(shouldFinalizeUserTurn(messages, 1000, {
      sessionKey: 'agent:main:session-1',
      status: 'idle',
      processing: false,
      hasTrackedUserRun: false,
      activeRunIds: [],
    })).toBe(true);
  });

  it('does not force abort stuck runs while backend is active', () => {
    expect(shouldForceAbortStuckRun({
      sessionKey: 'agent:main:session-1',
      status: 'processing',
      processing: true,
      hasTrackedUserRun: true,
      activeRunIds: ['run-1'],
    })).toBe(false);
  });
});
