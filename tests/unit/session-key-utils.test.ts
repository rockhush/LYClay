import { describe, expect, it } from 'vitest';
import {
  isHeartbeatSessionKey,
  isSubagentSessionKey,
  isUserFacingSessionKey,
  pickUserFacingSession,
} from '@/lib/session-key-utils';

describe('session-key-utils', () => {
  it('detects heartbeat session keys', () => {
    expect(isHeartbeatSessionKey('agent:main:main')).toBe(true);
    expect(isHeartbeatSessionKey('agent:coder:main')).toBe(true);
    expect(isHeartbeatSessionKey('agent:main:session-1')).toBe(false);
    expect(isHeartbeatSessionKey('agent:main:subagent:child-123')).toBe(false);
  });

  it('detects OpenClaw subagent session keys', () => {
    expect(isSubagentSessionKey('agent:main:subagent:974af0a0-b37d-40a2-ae06-51dab4f41f32')).toBe(true);
    expect(isSubagentSessionKey('agent:coder:subagent:child-123')).toBe(true);
  });

  it('treats normal user sessions as user-facing', () => {
    expect(isUserFacingSessionKey('agent:main:main')).toBe(true);
    expect(isUserFacingSessionKey('agent:main:session-1717848000000')).toBe(true);
    expect(isUserFacingSessionKey('agent:main:subagent:child-123')).toBe(false);
    expect(isUserFacingSessionKey('agent:main:scheduled-task:job-1:run-abc')).toBe(false);
    expect(isUserFacingSessionKey('agent:main:cron-run:job-1:run-abc')).toBe(false);
    expect(isUserFacingSessionKey('agent:main:cron:job-1')).toBe(false);
    expect(isUserFacingSessionKey('agent:dingtalk:dingtalk:group:11236149')).toBe(false);
    expect(isUserFacingSessionKey('agent:dingtalk:dingtalk:default:direct:11427192')).toBe(true);
    expect(isUserFacingSessionKey('agent:dingtalk:session-1717848000000')).toBe(true);
  });

  it('detects OpenClaw channel mirror session keys', () => {
    expect(isChannelMirrorSessionKey('agent:dingtalk:dingtalk:group:11236149')).toBe(true);
    expect(isChannelMirrorSessionKey('agent:support:feishu:group:oc_xxx')).toBe(true);
    expect(isChannelMirrorSessionKey('agent:dingtalk:dingtalk:default:direct:11427192')).toBe(false);
    expect(isChannelMirrorSessionKey('agent:dingtalk:session-1717848000000')).toBe(false);
    expect(isChannelMirrorSessionKey('agent:dingtalk:main')).toBe(false);
    expect(isChannelMirrorSessionKey('agent:main:subagent:child-123')).toBe(false);
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
