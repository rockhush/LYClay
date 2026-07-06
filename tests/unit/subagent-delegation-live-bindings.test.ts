import { describe, expect, it } from 'vitest';
import {
  collectChildDelegationBindings,
  mergeDelegationBindingsWithLiveStream,
} from '@/lib/subagent-delegation';
import type { RawMessage } from '@/stores/chat/types';

const childKey = 'agent:main:subagent:ppt-child';

describe('mergeDelegationBindingsWithLiveStream', () => {
  it('adds a provisional child branch while spawn is visible in streaming tools', () => {
    const segmentMessages: RawMessage[] = [
      {
        role: 'assistant',
        content: [{
          type: 'toolCall',
          id: 'call_spawn',
          name: 'sessions_spawn',
          input: { taskName: 'ppt-generation' },
        }],
      },
    ];

    const bindings = mergeDelegationBindingsWithLiveStream(
      collectChildDelegationBindings(segmentMessages, new Set()),
      segmentMessages,
      null,
      [{
        id: 'call_spawn',
        name: 'sessions_spawn',
        status: 'running',
        summary: '',
      }],
      new Set(),
      [childKey],
    );

    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.childSessionKey).toBe(childKey);
    expect(bindings[0]?.label).toBeNull();
  });

  it('parses child session key from completed streaming tool summary', () => {
    const bindings = mergeDelegationBindingsWithLiveStream(
      [],
      [],
      null,
      [{
        toolCallId: 'call_spawn',
        name: 'sessions_spawn',
        status: 'completed',
        summary: JSON.stringify({
          status: 'accepted',
          childSessionKey: childKey,
          runId: 'child-run',
          taskName: 'ppt-generation',
        }),
      }],
      new Set(),
      [],
    );

    expect(bindings).toEqual([{
      childSessionKey: childKey,
      spawnToolCallId: 'call_spawn',
      label: 'ppt-generation',
      spawnMessageIndex: 0,
      completed: false,
      runId: 'child-run',
    }]);
  });

  it('does not duplicate transcript bindings', () => {
    const segmentMessages: RawMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call_spawn', name: 'sessions_spawn', input: { taskName: 'ppt' } }],
      },
      {
        role: 'toolresult',
        toolCallId: 'call_spawn',
        content: JSON.stringify({ childSessionKey: childKey, runId: 'child-run', taskName: 'ppt' }),
      },
    ];
    const transcriptBindings = collectChildDelegationBindings(segmentMessages, new Set());

    const merged = mergeDelegationBindingsWithLiveStream(
      transcriptBindings,
      segmentMessages,
      null,
      [],
      new Set(),
      [childKey],
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]?.childSessionKey).toBe(childKey);
  });
});
