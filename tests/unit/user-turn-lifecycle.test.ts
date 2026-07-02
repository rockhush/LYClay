import { describe, expect, it } from 'vitest';
import {
  backendActivityForSession,
  buildReAdoptRunPatch,
  canClearUserTurnNow,
  canForceClearOnVisibleCommittedReply,
  DELEGATION_FINALIZE_GRACE_MS,
  deriveHasActiveRunSignal,
  deriveIsExecuting,
  deriveSidebarSessionIsExecuting,
  releaseUserAbortedSessionWhenIdle,
  isUserAbortedSessionBackendIdle,
  isBackendSessionActive,
  isTranscriptOnlyDelegationDefer,
  sanitizeLeavingSessionStreamingSnapshot,
  shouldFinalizeUserTurn,
  shouldForceAbortStuckRun,
} from '@/stores/chat/user-turn-lifecycle';
import {
  _resetUserAbortedSessionsForTests,
  isUserAbortedSession,
  persistUserAbortedSession,
} from '@/stores/chat/user-aborted-sessions';
import { hasInFlightSubagentSignals } from '@/lib/subagent-delegation';
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

  it('finalizes after a terminal reply even if current session has weak background processing', () => {
    const messages: RawMessage[] = [
      { role: 'user', content: 'open platform', timestamp: 1000 },
      terminalAssistant,
    ];
    const backend = {
      sessionKey: 'agent:main:session-1',
      status: 'processing',
      processing: true,
      hasTrackedUserRun: false,
      activeRunIds: [],
    };
    const background = {
      hasBackgroundProcessing: true,
      processingSessionKeys: ['agent:main:session-1'],
    };

    expect(shouldFinalizeUserTurn(
      messages,
      1000,
      backend,
      terminalAssistant,
      background,
    )).toBe(true);
    expect(canClearUserTurnNow({
      messages,
      lastUserMessageAt: 1000,
      backendActivity: backend,
      terminalMessage: terminalAssistant,
      gatewayBackground: background,
    })).toBe(true);
    expect(deriveIsExecuting(
      { sending: true, activeRunId: 'stale-run', pendingFinal: true },
      backend,
      { messages, lastUserMessageAt: 1000, gatewayBackground: background },
    )).toBe(false);
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
    }    )).toBe(false);
  });

  it('forces clear when visible concluding reply exists but stale hasTrackedUserRun blocks canClear', () => {
    const messages: RawMessage[] = [
      { role: 'user', content: 'summarize', timestamp: 1000 },
      { role: 'assistant', content: [{ type: 'toolCall', id: 't1', name: 'read', arguments: {} }], timestamp: 1500 },
      { role: 'assistant', content: 'Here is the summary.', timestamp: 2000 },
    ];
    const backend = {
      sessionKey: 'agent:main:session-1',
      status: 'processing',
      processing: true,
      hasTrackedUserRun: true,
      activeRunIds: ['stale-run'],
    };
    const background = {
      hasBackgroundProcessing: false,
      processingSessionKeys: [],
    };
    const input = {
      messages,
      lastUserMessageAt: 1000,
      backendActivity: backend,
      gatewayBackground: background,
    };
    expect(canClearUserTurnNow(input)).toBe(false);
    expect(canForceClearOnVisibleCommittedReply(input)).toBe(true);
  });

  it('does not force clear when gateway still lists the session as processing', () => {
    const messages: RawMessage[] = [
      { role: 'user', content: 'question', timestamp: 1000 },
      terminalAssistant,
    ];
    expect(canForceClearOnVisibleCommittedReply({
      messages,
      lastUserMessageAt: 1000,
      backendActivity: {
        sessionKey: 'agent:main:session-1',
        status: 'processing',
        processing: true,
        hasTrackedUserRun: true,
        activeRunIds: ['run-1'],
      },
      gatewayBackground: {
        hasBackgroundProcessing: true,
        processingSessionKeys: ['agent:main:session-1'],
      },
    })).toBe(false);
  });

  it('sanitizeLeavingSessionStreamingSnapshot clears stale run flags when transcript is visibly complete', () => {
    const sessionKey = 'agent:main:session-a';
    const messages: RawMessage[] = [
      { role: 'user', content: 'make ppt', timestamp: 1000 },
      { role: 'assistant', content: 'PPT done', stopReason: 'stop', timestamp: 2000 },
    ];
    const dirty = {
      activeRunId: 'run-stale',
      activeTool: null,
      streamingText: 'partial',
      streamingMessage: { role: 'assistant', content: 'partial' },
      streamingTools: [],
      pendingFinal: true,
      lastUserMessageAt: 1000,
      pendingToolImages: [],
      runAborted: false,
      runError: null,
      sending: true,
      messagesSnapshot: messages,
    };

    expect(sanitizeLeavingSessionStreamingSnapshot(dirty, {
      sessionKey,
      gatewayBackground: { hasBackgroundProcessing: false, processingSessionKeys: [] },
    })).toEqual({
      ...dirty,
      sending: false,
      pendingFinal: false,
      activeRunId: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingToolImages: [],
      activeTool: null,
    });
  });

  it('sanitizeLeavingSessionStreamingSnapshot keeps active snapshots while gateway still processes the session', () => {
    const sessionKey = 'agent:main:session-a';
    const messages: RawMessage[] = [
      { role: 'user', content: 'question', timestamp: 1000 },
      terminalAssistant,
    ];
    const dirty = {
      activeRunId: 'run-live',
      activeTool: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: true,
      lastUserMessageAt: 1000,
      pendingToolImages: [],
      runAborted: false,
      runError: null,
      sending: true,
      messagesSnapshot: messages,
    };

    expect(sanitizeLeavingSessionStreamingSnapshot(dirty, {
      sessionKey,
      gatewayBackground: {
        hasBackgroundProcessing: true,
        processingSessionKeys: [sessionKey],
      },
    })).toBe(dirty);
  });

  it('sanitizeLeavingSessionStreamingSnapshot leaves idle snapshots unchanged', () => {
    const snapshot = {
      activeRunId: null,
      activeTool: null,
      streamingText: '',
      streamingMessage: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: 1000,
      pendingToolImages: [],
      runAborted: false,
      runError: null,
      sending: false,
      messagesSnapshot: [
        { role: 'user', content: 'q', timestamp: 1000 },
        terminalAssistant,
      ],
    };
    expect(sanitizeLeavingSessionStreamingSnapshot(snapshot, {
      sessionKey: 'agent:main:session-a',
    })).toBe(snapshot);
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

  it('does not re-adopt run state for persisted user-aborted sessions', () => {
    _resetUserAbortedSessionsForTests();
    persistUserAbortedSession('agent:main:session-1', 'run-1');
    expect(buildReAdoptRunPatch(
      {
        currentSessionKey: 'agent:main:session-1',
        sending: false,
        activeRunId: null,
        pendingFinal: false,
        runAborted: false,
      },
      'agent:main:session-1',
      {
        sessionKey: 'agent:main:session-1',
        status: 'processing',
        processing: true,
        hasTrackedUserRun: true,
        activeRunIds: ['run-1'],
      },
    )).toBeNull();
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
    const gatewayBackground = {
      hasBackgroundProcessing: true,
      processingSessionKeys: ['agent:main:subagent:child-123'],
    };
    expect(shouldFinalizeUserTurn(messages, 1000, {
      sessionKey: 'agent:main:session-1',
      status: 'idle',
      processing: false,
      hasTrackedUserRun: false,
      activeRunIds: [],
    }, terminalAssistant, gatewayBackground)).toBe(false);
  });

  it('finalizes after child gateway work completes even without transcript completion marker', () => {
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
    }, terminalAssistant, { hasBackgroundProcessing: false, processingSessionKeys: [] })).toBe(true);
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
        content: [{ type: 'text', text: 'File written.' }],
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

  it('does not force abort stuck runs while gateway reports open work for this session', () => {
    expect(shouldForceAbortStuckRun({
      sessionKey: 'agent:main:session-1',
      status: 'processing',
      processing: true,
      hasTrackedUserRun: true,
      activeRunIds: ['run-1'],
    })).toBe(false);
    expect(shouldForceAbortStuckRun(
      {
        sessionKey: 'agent:main:session-1',
        status: 'idle',
        processing: false,
        hasTrackedUserRun: false,
        activeRunIds: [],
      },
      { hasBackgroundProcessing: true, processingSessionKeys: ['agent:main:subagent:child-1'] },
      [
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
              childSessionKey: 'agent:main:subagent:child-1',
              runId: 'child-run',
            }),
          }],
        },
      ],
    )).toBe(false);
  });

  it('does not re-adopt run state for an empty session when only unrelated sessions are processing', () => {
    expect(buildReAdoptRunPatch(
      {
        currentSessionKey: 'agent:main:session-new',
        sending: false,
        activeRunId: null,
        pendingFinal: false,
        messages: [],
      },
      'agent:main:session-new',
      {
        sessionKey: 'agent:main:session-new',
        status: 'idle',
        processing: false,
        hasTrackedUserRun: false,
        activeRunIds: [],
      },
      {
        hasBackgroundProcessing: true,
        processingSessionKeys: ['agent:main:subagent:other-child'],
      },
    )).toBeNull();
  });

  it('does not clear parent turn on silent NO_REPLY final while child spawn is in flight', () => {
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
    ];
    const silentParentFinal: RawMessage = {
      role: 'assistant',
      content: 'NO_REPLY',
      stopReason: 'stop',
      timestamp: 3000,
    };

    expect(canClearUserTurnNow({
      messages,
      lastUserMessageAt: 1000,
      backendActivity: {
        sessionKey: 'agent:main:session-1',
        status: 'idle',
        processing: false,
        hasTrackedUserRun: false,
        activeRunIds: [],
      },
      terminalMessage: silentParentFinal,
      gatewayBackground: {
        hasBackgroundProcessing: true,
        processingSessionKeys: ['agent:main:subagent:child-123'],
      },
    })).toBe(false);
  });

  it('detects in-flight spawn from live streaming assistant before history commits', () => {
    expect(hasInFlightSubagentSignals(
      [{ role: 'user', content: 'go' }],
      {
        streamingMessage: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'spawn-live',
            name: 'sessions_spawn',
            input: { task: 'child work' },
          }],
        },
      },
    )).toBe(true);
  });

  it('does not defer finalize on gateway-idle spawn without parent conclusion', () => {
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
    ];
    const idleBackend = {
      sessionKey: 'agent:main:session-1',
      status: 'idle',
      processing: false,
      hasTrackedUserRun: false,
      activeRunIds: [],
    };
    expect(isTranscriptOnlyDelegationDefer(messages, { hasBackgroundProcessing: false, processingSessionKeys: [] }, idleBackend)).toBe(false);
    expect(canClearUserTurnNow({
      messages,
      lastUserMessageAt: 1000,
      backendActivity: idleBackend,
      gatewayBackground: { hasBackgroundProcessing: false, processingSessionKeys: [] },
    })).toBe(false);
  });

  it('allows finalize after grace when gateway stays idle but transcript still blocks', () => {
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
    const idleBackend = {
      sessionKey: 'agent:main:session-1',
      status: 'idle',
      processing: false,
      hasTrackedUserRun: false,
      activeRunIds: [],
    };
    const graceStartedAt = 1_000;
    expect(canClearUserTurnNow({
      messages,
      lastUserMessageAt: 1000,
      backendActivity: idleBackend,
      terminalMessage: terminalAssistant,
      gatewayBackground: { hasBackgroundProcessing: false, processingSessionKeys: [] },
      finalizeGraceStartedAt: graceStartedAt,
      nowMs: graceStartedAt + DELEGATION_FINALIZE_GRACE_MS,
    })).toBe(true);
  });

  it('never grace-finalizes while gateway still reports strong backend work', () => {
    const messages: RawMessage[] = [
      { role: 'user', content: 'question', timestamp: 1000 },
      terminalAssistant,
    ];
    expect(canClearUserTurnNow({
      messages,
      lastUserMessageAt: 1000,
      backendActivity: {
        sessionKey: 'agent:main:session-1',
        status: 'processing',
        processing: true,
        hasTrackedUserRun: true,
        activeRunIds: ['run-1'],
      },
      terminalMessage: terminalAssistant,
      gatewayBackground: { hasBackgroundProcessing: false, processingSessionKeys: [] },
      finalizeGraceStartedAt: 1_000,
      nowMs: 1_000 + DELEGATION_FINALIZE_GRACE_MS + 5_000,
    })).toBe(false);
  });

  it('does not clear parent turn while spawn tool result is still missing from transcript', () => {
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
        role: 'assistant',
        content: 'NO_REPLY',
        stopReason: 'stop',
        timestamp: 2000,
      },
    ];
    const idleBackend = {
      sessionKey: 'agent:main:session-1',
      status: 'idle',
      processing: false,
      hasTrackedUserRun: false,
      activeRunIds: [],
    };
    expect(canClearUserTurnNow({
      messages,
      lastUserMessageAt: 1000,
      backendActivity: idleBackend,
      gatewayBackground: { hasBackgroundProcessing: false, processingSessionKeys: [] },
    })).toBe(false);
    expect(deriveIsExecuting(
      { sending: false, activeRunId: null, pendingFinal: false },
      idleBackend,
      { messages, lastUserMessageAt: 1000 },
    )).toBe(true);
  });

  it('stops executing after delegation wrap-up even when pendingFinal is stale', () => {
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
        content: 'PPT is ready.',
        stopReason: 'stop',
        timestamp: 4000,
      },
    ];
    const idleBackend = {
      sessionKey: 'agent:main:session-1',
      status: 'idle',
      processing: false,
      hasTrackedUserRun: true,
      activeRunIds: ['stale-announce-run'],
    };
    expect(deriveIsExecuting(
      { sending: true, activeRunId: 'announce:v1:agent:main:subagent:child-123:child-run', pendingFinal: true },
      idleBackend,
      {
        messages,
        lastUserMessageAt: 1000,
        gatewayBackground: { hasBackgroundProcessing: false, processingSessionKeys: [] },
      },
    )).toBe(false);
  });

  it('stops executing when a visible final reply is committed and only local run flags are stale', () => {
    const messages: RawMessage[] = [
      { role: 'user', content: 'open the RFQ platform', timestamp: 1000 },
      {
        role: 'assistant',
        content: 'The RFQ platform is open. Please upload your Excel file.',
        stopReason: 'stop',
        timestamp: 2000,
      },
    ];

    expect(deriveIsExecuting(
      { sending: true, activeRunId: 'run-stale-local', pendingFinal: true },
      {
        sessionKey: 'agent:main:session-1',
        status: 'idle',
        processing: false,
        hasTrackedUserRun: false,
        activeRunIds: [],
      },
      {
        messages,
        lastUserMessageAt: 1000,
        gatewayBackground: { hasBackgroundProcessing: false, processingSessionKeys: [] },
      },
    )).toBe(false);
  });

  it('clears stale execution after delegated visible answer followed by silent NO_REPLY', () => {
    const messages: RawMessage[] = [
      { role: 'user', content: 'generate report', timestamp: 1000 },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'spawn-1', name: 'sessions_spawn', input: { task: 'report' } }],
        stopReason: 'toolUse',
        timestamp: 2000,
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
        timestamp: 2500,
      },
      {
        role: 'assistant',
        content: 'DOE report is ready. Please review the attached result.',
        stopReason: 'stop',
        timestamp: 4000,
      },
    ];
    const silentFinal: RawMessage = {
      role: 'assistant',
      content: 'NO_REPLY',
      stopReason: 'stop',
      timestamp: 5000,
    };
    const idleBackend = {
      sessionKey: 'agent:main:session-1',
      status: 'idle',
      processing: false,
      hasTrackedUserRun: false,
      activeRunIds: [],
    };
    const gatewayBackground = { hasBackgroundProcessing: false, processingSessionKeys: [] };

    expect(canClearUserTurnNow({
      messages,
      lastUserMessageAt: 1000,
      backendActivity: idleBackend,
      terminalMessage: silentFinal,
      gatewayBackground,
    })).toBe(true);
    expect(deriveIsExecuting(
      { sending: true, activeRunId: 'announce:v1:agent:main:subagent:child-123:child-run', pendingFinal: true },
      idleBackend,
      { messages, lastUserMessageAt: 1000, gatewayBackground },
    )).toBe(false);
  });

  it('does not clear a silent delegated final when the active user turn has no visible answer', () => {
    const messages: RawMessage[] = [
      { role: 'user', content: 'generate report', timestamp: 1000 },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'spawn-1', name: 'sessions_spawn', input: { task: 'report' } }],
        stopReason: 'toolUse',
        timestamp: 2000,
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
        timestamp: 2500,
      },
    ];
    const silentFinal: RawMessage = {
      role: 'assistant',
      content: 'NO_REPLY',
      stopReason: 'stop',
      timestamp: 3000,
    };
    const idleBackend = {
      sessionKey: 'agent:main:session-1',
      status: 'idle',
      processing: false,
      hasTrackedUserRun: false,
      activeRunIds: [],
    };
    const gatewayBackground = { hasBackgroundProcessing: false, processingSessionKeys: [] };

    expect(canClearUserTurnNow({
      messages,
      lastUserMessageAt: 1000,
      backendActivity: idleBackend,
      terminalMessage: silentFinal,
      gatewayBackground,
    })).toBe(false);
    expect(deriveIsExecuting(
      { sending: true, activeRunId: 'announce:v1:agent:main:subagent:child-123:child-run', pendingFinal: true },
      idleBackend,
      { messages, lastUserMessageAt: 1000, gatewayBackground },
    )).toBe(true);
  });

  it('keeps the delegated turn active when a sibling child is still processing', () => {
    const messages: RawMessage[] = [
      { role: 'user', content: 'generate two reports', timestamp: 1000 },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'spawn-1', name: 'sessions_spawn', input: { task: 'report 1' } }],
        stopReason: 'toolUse',
        timestamp: 2000,
      },
      {
        role: 'toolResult',
        toolCallId: 'spawn-1',
        content: [{ type: 'text', text: JSON.stringify({ status: 'accepted', childSessionKey: 'agent:main:subagent:child-1', runId: 'child-run-1' }) }],
        timestamp: 2100,
      },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'spawn-2', name: 'sessions_spawn', input: { task: 'report 2' } }],
        stopReason: 'toolUse',
        timestamp: 2200,
      },
      {
        role: 'toolResult',
        toolCallId: 'spawn-2',
        content: [{ type: 'text', text: JSON.stringify({ status: 'accepted', childSessionKey: 'agent:main:subagent:child-2', runId: 'child-run-2' }) }],
        timestamp: 2300,
      },
      {
        role: 'assistant',
        content: 'The first report is ready; waiting for the second.',
        stopReason: 'stop',
        timestamp: 4000,
      },
    ];
    const idleBackend = {
      sessionKey: 'agent:main:session-1',
      status: 'idle',
      processing: false,
      hasTrackedUserRun: false,
      activeRunIds: [],
    };
    const gatewayBackground = {
      hasBackgroundProcessing: true,
      processingSessionKeys: ['agent:main:subagent:child-2'],
    };

    expect(canClearUserTurnNow({
      messages,
      lastUserMessageAt: 1000,
      backendActivity: idleBackend,
      gatewayBackground,
    })).toBe(false);
    expect(deriveIsExecuting(
      { sending: true, activeRunId: 'announce:v1:agent:main:subagent:child-1:child-run-1', pendingFinal: true },
      idleBackend,
      { messages, lastUserMessageAt: 1000, gatewayBackground },
    )).toBe(true);
  });
  it('deriveSidebarSessionIsExecuting treats completed background snapshots as idle despite stale run ids', () => {
    const sessionKey = 'agent:main:session-a';
    const messages: RawMessage[] = [
      { role: 'user', content: 'ten english words', timestamp: 1000 },
      {
        role: 'assistant',
        content: 'word list',
        stopReason: 'stop',
        timestamp: 2000,
      },
    ];

    expect(deriveSidebarSessionIsExecuting({
      sessionKey,
      isCurrent: false,
      currentUi: { sending: false, activeRunId: null, pendingFinal: false },
      currentMessages: [],
      currentLastUserMessageAt: null,
      currentStreamingMessage: null,
      waitingOnSubagentDelegation: false,
      sessionBackendActivity: null,
      gatewayBackground: { hasBackgroundProcessing: false, processingSessionKeys: [] },
      snapshot: {
        activeRunId: 'run-stale',
        pendingFinal: true,
        sending: false,
        runAborted: false,
        lastUserMessageAt: 1000,
        streamingMessage: null,
        messagesSnapshot: messages,
      },
    })).toBe(false);
  });

  it('deriveSidebarSessionIsExecuting keeps background sessions running when gateway still processes them', () => {
    const sessionKey = 'agent:main:session-b';
    expect(deriveSidebarSessionIsExecuting({
      sessionKey,
      isCurrent: false,
      currentUi: { sending: false, activeRunId: null, pendingFinal: false },
      currentMessages: [],
      currentLastUserMessageAt: null,
      currentStreamingMessage: null,
      waitingOnSubagentDelegation: false,
      sessionBackendActivity: null,
      gatewayBackground: {
        hasBackgroundProcessing: true,
        processingSessionKeys: [sessionKey],
      },
      snapshot: null,
    })).toBe(true);
  });

  it('deriveSidebarSessionIsExecuting clears stale processingKeys when snapshot turn is complete', () => {
    const sessionKey = 'agent:main:session-stale-proc';
    const messages: RawMessage[] = [
      { role: 'user', content: 'ten english words', timestamp: 1000 },
      {
        role: 'assistant',
        content: 'word list',
        stopReason: 'stop',
        timestamp: 2000,
      },
    ];

    expect(deriveSidebarSessionIsExecuting({
      sessionKey,
      isCurrent: false,
      currentUi: { sending: false, activeRunId: null, pendingFinal: false },
      currentMessages: [],
      currentLastUserMessageAt: null,
      currentStreamingMessage: null,
      waitingOnSubagentDelegation: false,
      sessionBackendActivity: null,
      gatewayBackground: {
        hasBackgroundProcessing: true,
        processingSessionKeys: [sessionKey],
      },
      snapshot: {
        activeRunId: 'run-stale',
        pendingFinal: true,
        sending: true,
        runAborted: false,
        lastUserMessageAt: 1000,
        streamingMessage: null,
        messagesSnapshot: messages,
      },
    })).toBe(false);
  });

  it('deriveSidebarSessionIsExecuting keeps actively streaming background snapshots running', () => {
    const sessionKey = 'agent:main:session-c';
    expect(deriveSidebarSessionIsExecuting({
      sessionKey,
      isCurrent: false,
      currentUi: { sending: false, activeRunId: null, pendingFinal: false },
      currentMessages: [],
      currentLastUserMessageAt: null,
      currentStreamingMessage: null,
      waitingOnSubagentDelegation: false,
      sessionBackendActivity: null,
      gatewayBackground: { hasBackgroundProcessing: false, processingSessionKeys: [] },
      snapshot: {
        activeRunId: 'run-live',
        pendingFinal: true,
        sending: true,
        runAborted: false,
        lastUserMessageAt: Date.now(),
        streamingMessage: { role: 'assistant', content: 'partial' },
        messagesSnapshot: [{ role: 'user', content: 'go', timestamp: 1000 }],
      },
    })).toBe(true);
  });

  it('deriveSidebarSessionIsExecuting treats user-aborted background sessions as idle while gateway still processes them', () => {
    const sessionKey = 'agent:main:session-aborted';
    persistUserAbortedSession(sessionKey, 'run-aborted');

    expect(deriveSidebarSessionIsExecuting({
      sessionKey,
      isCurrent: false,
      currentUi: { sending: false, activeRunId: null, pendingFinal: false },
      currentMessages: [],
      currentLastUserMessageAt: null,
      currentStreamingMessage: null,
      waitingOnSubagentDelegation: false,
      sessionBackendActivity: null,
      gatewayBackground: {
        hasBackgroundProcessing: true,
        processingSessionKeys: [sessionKey],
      },
      snapshot: {
        activeRunId: null,
        pendingFinal: false,
        sending: false,
        runAborted: true,
        lastUserMessageAt: Date.now(),
        streamingMessage: null,
        messagesSnapshot: [{ role: 'user', content: 'make ppt', timestamp: 1000 }],
      },
    })).toBe(false);

    _resetUserAbortedSessionsForTests();
  });

  it('deriveSidebarSessionIsExecuting treats runAborted snapshots as idle despite stale processingKeys', () => {
    const sessionKey = 'agent:main:session-aborted-snapshot';

    expect(deriveSidebarSessionIsExecuting({
      sessionKey,
      isCurrent: false,
      currentUi: { sending: false, activeRunId: null, pendingFinal: false },
      currentMessages: [],
      currentLastUserMessageAt: null,
      currentStreamingMessage: null,
      waitingOnSubagentDelegation: false,
      sessionBackendActivity: null,
      gatewayBackground: {
        hasBackgroundProcessing: true,
        processingSessionKeys: [sessionKey],
      },
      snapshot: {
        activeRunId: 'run-stale',
        pendingFinal: false,
        sending: false,
        runAborted: true,
        lastUserMessageAt: Date.now(),
        streamingMessage: null,
        messagesSnapshot: [{ role: 'user', content: 'make ppt', timestamp: 1000 }],
      },
    })).toBe(false);
  });

  it('deriveIsExecuting returns false for persisted user-aborted sessions even when backend is active', () => {
    persistUserAbortedSession('agent:main:main', 'run-1');
    const activeBackend = {
      sessionKey: 'agent:main:main',
      status: 'running',
      processing: true,
      hasTrackedUserRun: true,
      activeRunIds: ['run-1'],
    };
    expect(deriveIsExecuting(
      { sending: false, activeRunId: null, pendingFinal: false, runAborted: false },
      activeBackend,
      { sessionKey: 'agent:main:main', messages: [] },
    )).toBe(false);
    _resetUserAbortedSessionsForTests();
  });

  it('isUserAbortedSessionBackendIdle reports idle without clearing the persisted marker', () => {
    persistUserAbortedSession('agent:main:main', 'run-1');
    const activeBackend = {
      sessionKey: 'agent:main:main',
      status: 'running',
      processing: true,
      hasTrackedUserRun: true,
      activeRunIds: ['run-1'],
    };
    const idleBackend = {
      sessionKey: 'agent:main:main',
      status: 'idle',
      processing: false,
      hasTrackedUserRun: false,
      activeRunIds: [],
    };

    expect(isUserAbortedSessionBackendIdle('agent:main:main', activeBackend)).toBe(false);
    expect(isUserAbortedSessionBackendIdle('agent:main:main', idleBackend)).toBe(true);
    expect(isUserAbortedSession('agent:main:main')).toBe(true);
    expect(releaseUserAbortedSessionWhenIdle('agent:main:main', idleBackend)).toBe(true);
    expect(isUserAbortedSession('agent:main:main')).toBe(true);
    _resetUserAbortedSessionsForTests();
  });
});
