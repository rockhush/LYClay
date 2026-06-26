import { describe, expect, it, vi } from 'vitest';
import { abortPendingChildDelegations } from '@/stores/chat/abort-child-delegations';
import type { RawMessage } from '@/stores/chat';

describe('abortPendingChildDelegations', () => {
  it('aborts every pending child session from spawn bindings', async () => {
    const messages: RawMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'spawn-1', name: 'sessions_spawn', input: { taskName: 'build_ppt' } }],
      },
      {
        role: 'tool',
        toolCallId: 'spawn-1',
        content: JSON.stringify({
          childSessionKey: 'agent:main:subagent:child-a',
          runId: 'run-child-a',
        }),
      },
      {
        role: 'user',
        content: '[Internal task completion event]\nsession_key: agent:main:subagent:child-a\nsession_id: done-a',
      },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'spawn-2', name: 'sessions_spawn', input: { taskName: 'build_ppt_final' } }],
      },
      {
        role: 'tool',
        toolCallId: 'spawn-2',
        content: JSON.stringify({
          childSessionKey: 'agent:main:subagent:child-b',
          runId: 'run-child-b',
        }),
      },
    ];

    const rpc = vi.fn().mockResolvedValue({ ok: true });
    await abortPendingChildDelegations(messages, rpc);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith(
      'sessions.abort',
      { key: 'agent:main:subagent:child-b', runId: 'run-child-b' },
      10_000,
    );
  });
});
