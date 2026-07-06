import { describe, expect, it } from 'vitest';
import {
  collectActiveChildDelegations,
  deriveDelegationTurnSnapshot,
  hasOpenSubagentDelegations,
  isDelegationPhaseOpen,
  isDelegationWrapUpComplete,
  isParentDelegationPhaseOpen,
  isSegmentDelegationPhaseOpen,
} from '@/lib/delegation-turn-state';
import type { RawMessage } from '@/stores/chat/types';

const spawnMessages = (childKeys: string[]): RawMessage[] => {
  const messages: RawMessage[] = [{ role: 'user', content: 'do work', timestamp: 1000 }];
  childKeys.forEach((childKey, index) => {
    const spawnId = `spawn-${index + 1}`;
    messages.push({
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: spawnId,
        name: 'sessions_spawn',
        input: { label: `task-${index + 1}` },
      }],
    });
    messages.push({
      role: 'toolResult',
      toolCallId: spawnId,
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: 'accepted',
          childSessionKey: childKey,
          runId: `run-${index + 1}`,
        }),
      }],
    });
  });
  return messages;
};

describe('delegation-turn-state', () => {
  it('keeps the turn open while any child is still active on the gateway', () => {
    const messages = spawnMessages([
      'agent:main:subagent:child-1',
      'agent:main:subagent:child-2',
    ]);
    messages.push({
      role: 'assistant',
      content: '[Internal task completion event]\nsession_key: agent:main:subagent:child-1\nsession_id: id-1',
    });

    const snapshot = deriveDelegationTurnSnapshot(messages, ['agent:main:subagent:child-2']);
    expect(snapshot.totalChildCount).toBe(2);
    expect(snapshot.activeChildCount).toBe(1);
    expect(snapshot.anyChildActive).toBe(true);
    expect(snapshot.allChildrenSettled).toBe(false);
    expect(hasOpenSubagentDelegations(messages, ['agent:main:subagent:child-2'])).toBe(true);
  });

  it('tracks each child independently for parallel spawns', () => {
    const messages = spawnMessages([
      'agent:main:subagent:child-1',
      'agent:main:subagent:child-2',
    ]);
    // child-2 has committed its completion marker; child-1 is still processing.
    messages.push({
      role: 'assistant',
      content: '[Internal task completion event]\nsession_key: agent:main:subagent:child-2\nsession_id: id-2',
    });

    const active = collectActiveChildDelegations(messages, ['agent:main:subagent:child-1']);
    expect(active).toHaveLength(1);
    expect(active[0]?.childSessionKey).toBe('agent:main:subagent:child-1');
    expect(active[0]?.status).toBe('running');
  });

  it('decouples display status from gateway-only finalize liveness', () => {
    // Right after spawn (no completion marker, gateway has not yet listed the
    // child): the per-child STATUS must stay "running" so the nested branch keeps
    // rendering + polling and does not collapse to "subagent run 完成". But the
    // gateway-only `active` flag must be false so it never blocks the parent turn
    // from finalizing.
    const snapshot = deriveDelegationTurnSnapshot(spawnMessages(['agent:main:subagent:child-1']), []);
    expect(snapshot.children[0]?.status).toBe('running');
    expect(snapshot.children[0]?.active).toBe(false);
    expect(snapshot.anyChildActive).toBe(false);
  });

  it('closes delegation phase only after all children settle', () => {
    const messages = spawnMessages(['agent:main:subagent:child-1']);
    messages.push({
      role: 'assistant',
      content: '[Internal task completion event]\nsession_key: agent:main:subagent:child-1\nsession_id: id-1',
    });

    const snapshot = deriveDelegationTurnSnapshot(messages, []);
    expect(snapshot.allChildrenSettled).toBe(true);
    expect(isDelegationPhaseOpen(snapshot, false)).toBe(false);
    expect(isDelegationPhaseOpen(snapshot, true)).toBe(true);
  });

  it('keeps parent turn open after child settles until parent concludes', () => {
    const messages = spawnMessages(['agent:main:subagent:child-1']);
    messages.push({
      role: 'assistant',
      content: 'NO_REPLY',
      stopReason: 'stop',
      timestamp: 3000,
    });
    messages.push({
      role: 'assistant',
      content: '[Internal task completion event]\nsession_key: agent:main:subagent:child-1\nsession_id: id-1',
    });

    expect(isParentDelegationPhaseOpen(messages, [])).toBe(false);

    messages.push({
      role: 'assistant',
      content: 'Here is the final answer.',
      stopReason: 'stop',
      timestamp: 4000,
    });
    expect(isParentDelegationPhaseOpen(messages, [])).toBe(false);
  });

  it('closes delegation after visible parent wrap-up without stopReason', () => {
    const messages = spawnMessages(['agent:main:subagent:child-1']);
    messages.push({
      role: 'assistant',
      content: '[Internal task completion event]\nsession_key: agent:main:subagent:child-1\nsession_id: id-1',
    });
    messages.push({
      role: 'assistant',
      content: 'Here is the final answer without an explicit stop reason.',
      timestamp: 4000,
    });

    expect(isParentDelegationPhaseOpen(messages, [])).toBe(false);
  });

  it('keeps parent turn open while spawn tool result is not committed yet', () => {
    const messages: RawMessage[] = [
      { role: 'user', content: 'delegate', timestamp: 1000 },
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

    expect(isParentDelegationPhaseOpen(messages, [])).toBe(true);
  });

  it('closes delegation when parent announce text is streaming and children are gateway-idle', () => {
    const messages = spawnMessages(['agent:main:subagent:child-1']);
    expect(isSegmentDelegationPhaseOpen(messages, [], {
      streamingMessage: {
        role: 'assistant',
        content: [{ type: 'text', text: 'PPT is ready.' }],
      },
    })).toBe(false);
  });

  it('closes delegation when announce final lands and children are gateway-idle', () => {
    const messages = spawnMessages(['agent:main:subagent:child-1']);
    messages.push({
      role: 'assistant',
      content: 'PPT is ready.',
      stopReason: 'stop',
      timestamp: 4000,
    });

    expect(isSegmentDelegationPhaseOpen(messages, [])).toBe(false);
    expect(deriveDelegationTurnSnapshot(messages, []).anyChildActive).toBe(false);
    expect(isDelegationWrapUpComplete(messages, [], { lastUserMessageAt: 1000 })).toBe(true);
  });

  it('closes delegation when wrap-up is committed despite stale streaming spawn snapshot', () => {
    const childKey = 'agent:main:subagent:child-1';
    const messages = spawnMessages([childKey]);
    messages.push({
      role: 'assistant',
      content: 'PPT is ready.',
      stopReason: 'stop',
      timestamp: 4000,
    });

    expect(isSegmentDelegationPhaseOpen(messages, [], {
      streamingMessage: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Now let me spawn a sub-agent.' },
          {
            type: 'tool_use',
            id: 'spawn-1',
            name: 'sessions_spawn',
            input: { taskName: 'ppt' },
          },
        ],
      },
      completedChildSessionKeys: new Set([childKey]),
    })).toBe(false);
  });

  it('does not keep children active on stale gateway keys after announce completion', () => {
    const childKey = 'agent:main:subagent:child-1';
    const messages = spawnMessages([childKey]);
    messages.push({
      role: 'assistant',
      content: 'PPT is ready.',
      stopReason: 'stop',
      timestamp: 4000,
    });

    const snapshot = deriveDelegationTurnSnapshot(
      messages,
      [childKey],
      { completedChildSessionKeys: new Set([childKey]) },
    );
    expect(snapshot.anyChildActive).toBe(false);
    expect(isSegmentDelegationPhaseOpen(messages, [childKey], {
      completedChildSessionKeys: new Set([childKey]),
    })).toBe(false);
  });

  it('does not strand the parent turn on a fire-and-forget mode:run spawn that never binds', () => {
    // `sessions_spawn` with mode:"run" returns `{status:'accepted'}` with NO
    // childSessionKey, so it never produces a binding. After the child times out
    // and the parent finishes the work inline, the turn must finalize — the
    // committed (but unbindable) spawn must not keep the phase open forever.
    const messages: RawMessage[] = [
      { role: 'user', content: 'make a ppt', timestamp: 1000 },
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'spawn-run-1',
          name: 'sessions_spawn',
          input: { taskName: 'ppt_digital_employee', mode: 'run' },
        }],
      },
      {
        role: 'toolResult',
        toolCallId: 'spawn-run-1',
        content: [{ type: 'text', text: JSON.stringify({ status: 'accepted' }) }],
      },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'exec-1', name: 'exec', input: { command: 'node make_ppt.js' } }],
      },
      { role: 'toolResult', toolCallId: 'exec-1', content: [{ type: 'text', text: 'PPT generated' }] },
      {
        role: 'assistant',
        content: 'PPT 已生成，共 15 页。',
        stopReason: 'stop',
        timestamp: 5000,
      },
    ];

    const snapshot = deriveDelegationTurnSnapshot(messages, [], { hasSpawnedChildren: true });
    expect(snapshot.anyChildActive).toBe(false);
    expect(snapshot.allChildrenSettled).toBe(true);
    expect(isParentDelegationPhaseOpen(messages, [], { lastUserMessageAt: 1000 })).toBe(false);
  });

  it('closes wrap-up after sessions_yield + announce exec round with stale gateway keys', () => {
    const childKey = 'agent:main:subagent:097d1c17-1a9e-455d-aec6-31d14fa468fb';
    const messages: RawMessage[] = [
      { role: 'user', content: 'make ppt', timestamp: 1000 },
      {
        role: 'assistant',
        content: [{
          type: 'toolCall',
          id: 'spawn-1',
          name: 'sessions_spawn',
          input: { taskName: 'ppt-generation', mode: 'run' },
        }],
      },
      {
        role: 'toolResult',
        toolCallId: 'spawn-1',
        content: [{
          type: 'text',
          text: JSON.stringify({ status: 'accepted', childSessionKey: childKey }),
        }],
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'PPT delegated to sub-agent.' },
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
        content: [
          { type: 'text', text: 'PPT 已生成完毕！' },
          { type: 'toolCall', id: 'exec-1', name: 'exec', arguments: {} },
        ],
        stopReason: 'toolUse',
      },
      { role: 'toolResult', toolCallId: 'exec-1', content: [{ type: 'text', text: '69059 bytes' }] },
      {
        role: 'assistant',
        content: '**数字员工建设方案.pptx** 已生成，共 15 页。',
        stopReason: 'stop',
        timestamp: 5000,
      },
    ];
    const completed = new Set([childKey]);
    const staleProcessing = ['agent:main:session-1782986240411', childKey];

    expect(isDelegationWrapUpComplete(messages, staleProcessing, {
      lastUserMessageAt: 1000,
      completedChildSessionKeys: completed,
    })).toBe(true);
    expect(isSegmentDelegationPhaseOpen(messages.slice(1), staleProcessing, {
      completedChildSessionKeys: completed,
    })).toBe(false);
  });

  it('closes wrap-up with stale gateway keys before completedChildSessionKeys is inferred', () => {
    const childKey = 'agent:main:subagent:49424d13-c3a3-4a4c-b9d5-5b1182bcd972';
    const messages: RawMessage[] = [
      { role: 'user', content: 'make ppt', timestamp: 1000 },
      {
        role: 'assistant',
        content: [{
          type: 'toolCall',
          id: 'spawn-1',
          name: 'sessions_spawn',
          input: { taskName: 'lyclaw-pptx-build' },
        }],
      },
      {
        role: 'toolResult',
        toolCallId: 'spawn-1',
        content: [{
          type: 'text',
          text: JSON.stringify({ status: 'accepted', childSessionKey: childKey }),
        }],
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'PPT 正在由子代理生成中，完成后我会通知你。' },
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
        content: '✅ **PPT 已生成完毕！**',
        stopReason: 'stop',
        timestamp: 5000,
      },
    ];
    const staleProcessing = ['agent:main:session-1782991299226', childKey];

    expect(isDelegationWrapUpComplete(messages, staleProcessing, {
      lastUserMessageAt: 1000,
    })).toBe(true);
    expect(isSegmentDelegationPhaseOpen(messages.slice(1), staleProcessing)).toBe(false);
  });

  it('keeps delegation open during interim wait before gateway lists the child', () => {
    const childKey = 'agent:main:subagent:digital-employee-pptx';
    const messages: RawMessage[] = [
      { role: 'user', content: 'make ppt', timestamp: 1000 },
      {
        role: 'assistant',
        content: [{
          type: 'toolCall',
          id: 'spawn-1',
          name: 'sessions_spawn',
          input: { taskName: 'digital-employee-pptx' },
        }],
      },
      {
        role: 'toolResult',
        toolCallId: 'spawn-1',
        content: [{
          type: 'text',
          text: JSON.stringify({ status: 'accepted', childSessionKey: childKey }),
        }],
      },
      {
        role: 'assistant',
        content: 'PPT 正在生成中，我启动了一个子任务专门来制作这份 15 页的演示文稿。生成完成后我会通知你，稍等一下～',
        stopReason: 'stop',
        timestamp: 3000,
      },
    ];

    expect(isParentDelegationPhaseOpen(messages, [], { lastUserMessageAt: 1000 })).toBe(true);
    expect(isSegmentDelegationPhaseOpen(messages.slice(1), [])).toBe(true);
    expect(isDelegationWrapUpComplete(messages, [], { lastUserMessageAt: 1000 })).toBe(false);
  });
});
