import { describe, expect, it } from 'vitest';
import {
  isSubagentSessionKey,
  isUserFacingSessionKey,
  pickUserFacingSession,
} from '@/lib/session-key-utils';

describe('session-key-utils', () => {
  it('detects OpenClaw subagent session keys', () => {
    expect(isSubagentSessionKey('agent:main:subagent:974af0a0-b37d-40a2-ae06-51dab4f41f32')).toBe(true);
    expect(isSubagentSessionKey('agent:coder:subagent:child-123')).toBe(true);
  });

  it('treats normal user sessions as user-facing', () => {
    expect(isUserFacingSessionKey('agent:main:main')).toBe(true);
    expect(isUserFacingSessionKey('agent:main:session-1717848000000')).toBe(true);
    expect(isUserFacingSessionKey('agent:main:subagent:child-123')).toBe(false);
  });

  it('picks the first user-facing session as fallback', () => {
    const sessions = [
      { key: 'agent:main:subagent:child-123', displayName: 'child' },
      { key: 'agent:main:session-1', displayName: 'main task' },
    ];
    expect(pickUserFacingSession(sessions)?.key).toBe('agent:main:session-1');
    expect(pickUserFacingSession(sessions, 'agent:main:session-1')?.key).toBe('agent:main:session-1');
  });
});
