import { describe, expect, it } from 'vitest';
import {
  detectStalledChildDelegation,
  hasActiveChildDelegations,
  SUBAGENT_STALL_WHILE_PROCESSING_MS,
} from '@/lib/subagent-delegation-watch';
import type { ChildDelegationBinding } from '@/lib/subagent-delegation';

const binding: ChildDelegationBinding = {
  childSessionKey: 'agent:main:subagent:child-1',
  spawnToolCallId: 'spawn-1',
  label: 'build_ppt',
  spawnMessageIndex: 1,
  completed: false,
  runId: 'run-child',
};

describe('subagent-delegation-watch', () => {
  it('keeps delegations active while gateway still processes the child key', () => {
    expect(hasActiveChildDelegations(
      [{ ...binding, completed: true }],
      ['agent:main:subagent:child-1'],
    )).toBe(true);
  });

  it('does not stall before the first child transcript poll', () => {
    const stalled = detectStalledChildDelegation(
      [binding],
      new Map(),
      [binding.childSessionKey],
    );
    expect(stalled).toBeNull();
  });

  it('detects stall when transcript stops growing during gateway processing', () => {
    const revisions = new Map([
      [binding.childSessionKey, {
        messageCount: 12,
        updatedAt: Date.now() - SUBAGENT_STALL_WHILE_PROCESSING_MS - 1_000,
      }],
    ]);
    const stalled = detectStalledChildDelegation(
      [binding],
      revisions,
      [binding.childSessionKey],
    );
    expect(stalled?.childSessionKey).toBe(binding.childSessionKey);
  });
});
