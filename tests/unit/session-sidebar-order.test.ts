import { describe, expect, it } from 'vitest';
import {
  buildStableSessionOrder,
  mergeDiscoveredSessionActivity,
} from '../../src/lib/session-sidebar-order';
import type { ChatSession } from '../../src/stores/chat';

function session(key: string, updatedAt?: number): ChatSession {
  return { key, updatedAt };
}

describe('session-sidebar-order', () => {
  it('mergeDiscoveredSessionActivity keeps existing timestamps', () => {
    expect(
      mergeDiscoveredSessionActivity(
        { 'agent:main:a': 100 },
        { 'agent:main:a': 500, 'agent:main:b': 200 },
      ),
    ).toEqual({
      'agent:main:a': 100,
      'agent:main:b': 200,
    });
  });

  it('buildStableSessionOrder keeps existing keys in place when activity changes', () => {
    const sessions = [
      session('agent:main:c', 300),
      session('agent:main:b', 200),
      session('agent:main:a', 100),
    ];
    const previousOrder = ['agent:main:a', 'agent:main:b', 'agent:main:c'];
    const bumpedActivity = {
      'agent:main:a': 100,
      'agent:main:b': 999,
      'agent:main:c': 300,
    };

    expect(buildStableSessionOrder(sessions, bumpedActivity, previousOrder)).toEqual(previousOrder);
  });

  it('buildStableSessionOrder prepends newly discovered sessions at the top', () => {
    const sessions = [
      session('agent:main:b', 200),
      session('agent:main:a', 100),
      session('agent:main:c', 300),
    ];

    expect(buildStableSessionOrder(sessions, {}, ['agent:main:a', 'agent:main:b'])).toEqual([
      'agent:main:c',
      'agent:main:a',
      'agent:main:b',
    ]);
  });
});
