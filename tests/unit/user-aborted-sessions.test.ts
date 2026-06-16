import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetUserAbortedSessionsForTests,
  clearUserAbortedSession,
  isUserAbortedSession,
  listUserAbortedSessionKeys,
  persistUserAbortedSession,
  reabortPersistedUserSessions,
} from '@/stores/chat/user-aborted-sessions';

describe('user-aborted-sessions persistence', () => {
  beforeEach(() => {
    window.localStorage.clear();
    _resetUserAbortedSessionsForTests();
  });

  it('persists and checks aborted session keys', () => {
    persistUserAbortedSession('agent:main:main', 'run-1');
    expect(isUserAbortedSession('agent:main:main')).toBe(true);
    expect(listUserAbortedSessionKeys()).toEqual(['agent:main:main']);
  });

  it('clears persisted abort when the user starts a new run', () => {
    persistUserAbortedSession('agent:main:main', 'run-1');
    clearUserAbortedSession('agent:main:main');
    expect(isUserAbortedSession('agent:main:main')).toBe(false);
  });

  it('re-aborts persisted sessions through gateway rpc', async () => {
    persistUserAbortedSession('agent:main:main', 'run-abc');
    persistUserAbortedSession('agent:main:other', 'run-def');
    const rpc = vi.fn().mockResolvedValue({ ok: true });

    await reabortPersistedUserSessions(rpc);

    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenCalledWith(
      'sessions.abort',
      { key: 'agent:main:main', runId: 'run-abc' },
      10_000,
    );
    expect(rpc).toHaveBeenCalledWith(
      'sessions.abort',
      { key: 'agent:main:other', runId: 'run-def' },
      10_000,
    );
  });
});
