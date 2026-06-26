import { describe, expect, it } from 'vitest';
import {
  collectActiveChildDelegations,
  deriveDelegationTurnSnapshot,
  hasOpenSubagentDelegations,
  isDelegationPhaseOpen,
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

    const active = collectActiveChildDelegations(messages, ['agent:main:subagent:child-1']);
    expect(active).toHaveLength(1);
    expect(active[0]?.childSessionKey).toBe('agent:main:subagent:child-1');
    expect(active[0]?.status).toBe('running');
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
});
