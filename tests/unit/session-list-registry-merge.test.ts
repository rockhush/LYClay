import { describe, expect, it } from 'vitest';
import {
  sessionHasRegistryRetentionSignals,
  unionGatewaySessionsWithLocalRegistry,
} from '@/lib/session-list-registry-merge';
import type { ChatSession } from '@/stores/chat/types';

const emptyCtx = {
  sessionLabels: {},
  customSessionLabels: {},
  sessionLastActivity: {},
  sessionWorkspaceIds: {},
  sessionPinnedAt: {},
};

describe('session-list-registry-merge', () => {
  it('retains local registry rows with preview text', () => {
    const session: ChatSession = {
      key: 'agent:main:session-1',
      firstUserMessagePreview: '起来看球了',
    };
    expect(sessionHasRegistryRetentionSignals(session, emptyCtx)).toBe(true);
  });

  it('does not retain scratchpad rows with no conversation signals', () => {
    const session: ChatSession = {
      key: 'agent:main:session-empty',
      updatedAt: Date.now(),
    };
    expect(sessionHasRegistryRetentionSignals(session, emptyCtx)).toBe(false);
  });

  it('unions local-only sessions missing from Gateway list', () => {
    const gateway: ChatSession[] = [{ key: 'agent:main:session-a', label: 'A' }];
    const local: ChatSession[] = [
      { key: 'agent:main:session-a', label: 'A' },
      { key: 'agent:main:session-b', firstUserMessagePreview: 'B question' },
    ];
    const merged = unionGatewaySessionsWithLocalRegistry(gateway, local, emptyCtx);
    expect(merged.map((session) => session.key)).toEqual([
      'agent:main:session-a',
      'agent:main:session-b',
    ]);
  });

  it('restores via persisted activity when preview is not ready yet', () => {
    const gateway: ChatSession[] = [];
    const local: ChatSession[] = [{ key: 'agent:main:session-c' }];
    const merged = unionGatewaySessionsWithLocalRegistry(gateway, local, {
      ...emptyCtx,
      sessionLastActivity: { 'agent:main:session-c': 1_700_000_000_000 },
    });
    expect(merged.map((session) => session.key)).toEqual(['agent:main:session-c']);
  });
});
