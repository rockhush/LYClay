import { describe, expect, it } from 'vitest';
import {
  canSyncClearAfterAnnounceWrapUp,
  reconcileUserTurnAfterDelegationWrapUp,
} from '@/stores/chat/finalize-turn-bridge';
import {
  deriveIsExecuting,
  hasTranscriptDelegationBlock,
} from '@/stores/chat/user-turn-lifecycle';
import type { ChatState, RawMessage } from '@/stores/chat/types';

const PARENT = 'agent:main:session-1782988245704';
const CHILD = 'agent:main:subagent:396af935-0041-458d-802f-28eb7fdb9ebb';
const ANNOUNCE_RUN = `announce:v1:${CHILD}:61d32796-0198-48a5-9ce8-7c98d448d116`;

function buildYieldAnnounceMessages(): RawMessage[] {
  return [
    { role: 'user', content: 'make ppt', timestamp: 1000 },
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'spawn-1', name: 'sessions_spawn', input: { taskName: 'pptx-build' } }],
    },
    {
      role: 'toolResult',
      toolCallId: 'spawn-1',
      content: [{ type: 'text', text: JSON.stringify({ status: 'accepted', childSessionKey: CHILD }) }],
    },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'PPT生成任务已交给子代理处理。' },
        { type: 'toolCall', id: 'yield-1', name: 'sessions_yield', arguments: {} },
      ],
      stopReason: 'toolUse',
    },
    {
      role: 'toolResult',
      toolCallId: 'yield-1',
      content: [{ type: 'text', text: JSON.stringify({ status: 'yielded' }) }],
    },
    {
      role: 'assistant',
      content: '**LYClaw_数字员工闭环体系.pptx** 已生成，共 15 页。',
      stopReason: 'stop',
      timestamp: 5000,
    },
  ];
}

describe('finalize-turn-bridge announce wrap-up', () => {
  it('sync-clears on visible announce final despite stale parent processingSessionKeys', () => {
    const messages = buildYieldAnnounceMessages();
    const terminal = messages[messages.length - 1];
    const staleProcessing = [PARENT, CHILD];

    expect(canSyncClearAfterAnnounceWrapUp(PARENT, messages, staleProcessing, {
      runId: ANNOUNCE_RUN,
      lastUserMessageAt: 1000,
      terminalMessage: terminal,
    })).toBe(true);
  });

  it('stops deriveIsExecuting after wrap-up despite stale parent processingSessionKeys', () => {
    const messages = buildYieldAnnounceMessages();
    const completed = new Set([CHILD]);

    expect(deriveIsExecuting(
      { sending: true, activeRunId: ANNOUNCE_RUN, pendingFinal: false, runAborted: false },
      {
        sessionKey: PARENT,
        status: 'processing',
        processing: true,
        hasTrackedUserRun: true,
        activeRunIds: [ANNOUNCE_RUN],
      },
      {
        messages,
        lastUserMessageAt: 1000,
        gatewayBackground: { hasBackgroundProcessing: true, processingSessionKeys: [PARENT, CHILD] },
        completedChildSessionKeys: completed,
      },
    )).toBe(false);
  });

  it('reconcileUserTurnAfterDelegationWrapUp clears stale sending when transcript wrap-up is complete', () => {
    const messages = buildYieldAnnounceMessages();
    let state: Partial<ChatState> = {
      currentSessionKey: PARENT,
      messages,
      lastUserMessageAt: 1000,
      sending: true,
      pendingFinal: true,
      activeRunId: ANNOUNCE_RUN,
      runAborted: false,
      announcedChildSessionKeys: [],
      gatewayBackgroundActivity: {
        hasBackgroundProcessing: true,
        processingSessionKeys: [PARENT, CHILD],
      },
      sessionBackendActivity: {
        sessionKey: PARENT,
        status: 'processing',
        processing: true,
        hasTrackedUserRun: true,
        activeRunIds: [ANNOUNCE_RUN],
      },
      sessionStreamingStates: {},
    };
    const get = () => state as ChatState;
    const set = (patch: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) => {
      state = { ...state, ...(typeof patch === 'function' ? patch(state as ChatState) : patch) };
    };

    expect(reconcileUserTurnAfterDelegationWrapUp(get, set, PARENT)).toBe(true);
    expect(state.sending).toBe(false);
    expect(state.pendingFinal).toBe(false);
    expect(state.activeRunId).toBeNull();
    expect(state.sessionStreamingStates?.[PARENT]?.sending).toBe(false);
  });

  it('reconcileUserTurnAfterDelegationWrapUp clears stale per-session snapshot on restore', () => {
    const messages = buildYieldAnnounceMessages();
    let state: Partial<ChatState> = {
      currentSessionKey: PARENT,
      messages,
      lastUserMessageAt: 1000,
      sending: false,
      pendingFinal: false,
      activeRunId: null,
      runAborted: false,
      announcedChildSessionKeys: [],
      gatewayBackgroundActivity: {
        hasBackgroundProcessing: true,
        processingSessionKeys: [PARENT, CHILD],
      },
      sessionStreamingStates: {
        [PARENT]: {
          activeRunId: ANNOUNCE_RUN,
          sending: true,
          pendingFinal: true,
          streamingText: '',
          streamingMessage: null,
          streamingTools: [],
          pendingToolImages: [],
          lastUserMessageAt: 1000,
          runAborted: false,
          messagesSnapshot: messages,
        },
      },
    };
    const get = () => state as ChatState;
    const set = (patch: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) => {
      state = { ...state, ...(typeof patch === 'function' ? patch(state as ChatState) : patch) };
    };

    expect(reconcileUserTurnAfterDelegationWrapUp(get, set, PARENT)).toBe(true);
    expect(state.sessionStreamingStates?.[PARENT]?.sending).toBe(false);
    expect(state.sessionStreamingStates?.[PARENT]?.activeRunId).toBeNull();
  });

  it('reconcileUserTurnAfterDelegationWrapUp prunes stale gateway keys after restart', () => {
    const messages = buildYieldAnnounceMessages();
    let state: Partial<ChatState> = {
      currentSessionKey: PARENT,
      messages,
      lastUserMessageAt: 1000,
      sending: false,
      pendingFinal: false,
      activeRunId: null,
      runAborted: false,
      announcedChildSessionKeys: [],
      gatewayBackgroundActivity: {
        hasBackgroundProcessing: true,
        processingSessionKeys: [PARENT, CHILD],
      },
      sessionStreamingStates: {},
    };
    const get = () => state as ChatState;
    const set = (patch: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) => {
      state = { ...state, ...(typeof patch === 'function' ? patch(state as ChatState) : patch) };
    };

    expect(reconcileUserTurnAfterDelegationWrapUp(get, set, PARENT)).toBe(true);
    expect(state.gatewayBackgroundActivity?.processingSessionKeys).not.toContain(CHILD);
  });

  it('hasTranscriptDelegationBlock defaults to transcript-inferred child completion', () => {
    const messages = buildYieldAnnounceMessages();
    const staleProcessing = [PARENT, CHILD];

    expect(hasTranscriptDelegationBlock(messages, {
      hasBackgroundProcessing: true,
      processingSessionKeys: staleProcessing,
    }, 1000)).toBe(false);
  });

  it('does not sync-clear on interim partial-phase announce', () => {
    const messages: RawMessage[] = [
      { role: 'user', content: 'make ppt', timestamp: 1000 },
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'spawn-1', name: 'sessions_spawn', input: { taskName: 'pptx-phase-1' } }],
      },
      {
        role: 'toolResult',
        toolCallId: 'spawn-1',
        content: [{ type: 'text', text: JSON.stringify({ status: 'accepted', childSessionKey: CHILD }) }],
      },
      {
        role: 'assistant',
        content: 'Phase 1（slides 1-5）也完成了！✅ 继续等待 Phase 3（slides 11-15）～',
        stopReason: 'stop',
        timestamp: 3000,
      },
    ];
    const terminal = messages[messages.length - 1];

    expect(canSyncClearAfterAnnounceWrapUp(PARENT, messages, [PARENT, CHILD], {
      runId: ANNOUNCE_RUN,
      lastUserMessageAt: 1000,
      terminalMessage: terminal,
    })).toBe(false);

    expect(deriveIsExecuting(
      { sending: false, activeRunId: null, pendingFinal: false, runAborted: false },
      {
        sessionKey: PARENT,
        status: null,
        processing: false,
        hasTrackedUserRun: false,
        activeRunIds: [],
      },
      {
        messages,
        lastUserMessageAt: null,
        gatewayBackground: { hasBackgroundProcessing: true, processingSessionKeys: [CHILD] },
      },
    )).toBe(true);
  });
});
