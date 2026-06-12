import { describe, expect, it } from 'vitest';
import {
  buildStableSessionOrder,
  getSessionBucket,
  mergeDiscoveredSessionActivity,
  resolveSessionActivityMs,
} from '../../src/lib/session-sidebar-order';
import type { ChatSession } from '../../src/stores/chat';

function session(key: string, options: { updatedAt?: number; lastMessageAt?: number } = {}): ChatSession {
  return { key, ...options };
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

  it('resolveSessionActivityMs prefers transcript lastMessageAt over stale activity', () => {
    const june2 = Date.parse('2026-06-02T18:37:00+08:00');
    const june9 = Date.parse('2026-06-09T12:00:00+08:00');

    expect(
      resolveSessionActivityMs(
        session('agent:main:demo', { lastMessageAt: june2, updatedAt: june9 }),
        { 'agent:main:demo': june9 },
      ),
    ).toBe(june2);
  });

  it('getSessionBucket places eight-day-old sessions in withinTwoWeeks', () => {
    const nowMs = Date.parse('2026-06-10T12:00:00+08:00');
    const activityMs = Date.parse('2026-06-02T18:37:00+08:00');

    expect(getSessionBucket(activityMs, nowMs)).toBe('withinTwoWeeks');
  });

  it('buildStableSessionOrder keeps existing keys in place when activity changes', () => {
    const sessions = [
      session('agent:main:c', { lastMessageAt: 300 }),
      session('agent:main:b', { lastMessageAt: 200 }),
      session('agent:main:a', { lastMessageAt: 100 }),
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
      session('agent:main:b', { lastMessageAt: 200 }),
      session('agent:main:a', { lastMessageAt: 100 }),
      session('agent:main:c', { lastMessageAt: 300 }),
    ];

    expect(buildStableSessionOrder(sessions, {}, ['agent:main:a', 'agent:main:b'])).toEqual([
      'agent:main:c',
      'agent:main:a',
      'agent:main:b',
    ]);
  });
});
