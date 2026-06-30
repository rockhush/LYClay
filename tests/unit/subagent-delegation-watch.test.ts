import { describe, expect, it } from 'vitest';
import {
  detectStalledChildDelegation,
  hasActiveChildDelegations,
  hasGatewayActiveChildDelegations,
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

  it('keeps an incomplete child visibly running until its transcript marker commits', () => {
    // Display semantics: no completion marker yet → still running, even if the
    // gateway momentarily does not list the child (transient processing gap).
    expect(hasActiveChildDelegations([binding], [])).toBe(true);
  });

  it('treats gateway-idle children as settled for finalize checks (gateway-only)', () => {
    // Finalize semantics: a missing/late transcript marker must not strand the
    // parent turn — gateway idle means the child is no longer open backend work.
    expect(hasGatewayActiveChildDelegations([binding], [])).toBe(false);
    expect(hasGatewayActiveChildDelegations([binding], ['agent:main:subagent:child-1'])).toBe(true);
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
