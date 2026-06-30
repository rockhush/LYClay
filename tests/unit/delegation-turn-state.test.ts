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
});
