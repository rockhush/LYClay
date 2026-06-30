import { describe, expect, it } from 'vitest';
import {
  isSubagentDelegationAnnounceRun,
  parseChildSessionKeyFromAnnounceRun,
} from '@/lib/subagent-delegation';

describe('parseChildSessionKeyFromAnnounceRun', () => {
  it('recovers the child session key embedded in an auto-announce wrap-up run id', () => {
    const runId =
      'announce:v1:agent:main:subagent:820258e6-a42b-4140-a0a8-569704c34582:b62d548c-46c7-4b8d-bf76-e2c212561cde';
    expect(parseChildSessionKeyFromAnnounceRun(runId)).toBe(
      'agent:main:subagent:820258e6-a42b-4140-a0a8-569704c34582',
    );
  });

  it('returns null for non-announce runs', () => {
    expect(parseChildSessionKeyFromAnnounceRun('b73752d8-6ff4-43aa-8c24-51f105152150')).toBeNull();
    expect(isSubagentDelegationAnnounceRun('b73752d8-6ff4-43aa-8c24-51f105152150')).toBe(false);
  });

  it('returns null for announce runs without a subagent segment', () => {
    expect(parseChildSessionKeyFromAnnounceRun('announce:v1:agent:main:run-1')).toBeNull();
  });

  it('returns null when the trailing gateway run id is missing', () => {
    // Without the trailing run-id segment there is no reliable child boundary.
    expect(
      parseChildSessionKeyFromAnnounceRun('announce:v1:agent:main:subagent:child-1'),
    ).toBeNull();
  });
});
