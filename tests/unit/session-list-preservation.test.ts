import { describe, expect, it } from 'vitest';
import {
  appendLocalOnlySessionSummaries,
  mergePreservedSessionsIntoGatewayList,
} from '@/lib/session-list-preservation';
import type { ChatSession } from '@/stores/chat/types';

describe('session-list-preservation', () => {
  it('preserves sessions stamped in sessionLastActivity after cold start', () => {
    const gatewaySessions: ChatSession[] = [{ key: 'agent:main:main', displayName: 'Main' }];
    const retiredKey = 'agent:employee-recruitment-specialist-128348c9:session-abc';

    const merged = mergePreservedSessionsIntoGatewayList(gatewaySessions, {
      sessions: [],
      sessionLabels: {},
      customSessionLabels: {},
      sessionLastActivity: { [retiredKey]: 1_700_000_000_000 },
      sessionWorkspaceIds: {},
    });

    expect(merged.map((session) => session.key)).toEqual([
      'agent:main:main',
      retiredKey,
    ]);
  });

  it('uses customSessionLabels for preserved session display names', () => {
    const sessionKey = 'agent:employee-recruitment-specialist-128348c9:session-abc';
    const merged = mergePreservedSessionsIntoGatewayList([], {
      sessions: [],
      sessionLabels: {},
      customSessionLabels: { [sessionKey]: '竞品分析' },
      sessionLastActivity: { [sessionKey]: 1 },
      sessionWorkspaceIds: {},
    });

    expect(merged).toEqual([{
      key: sessionKey,
      displayName: '竞品分析',
    }]);
  });

  it('does not preserve subagent or channel mirror keys from persisted state', () => {
    const merged = mergePreservedSessionsIntoGatewayList([], {
      sessions: [],
      sessionLabels: {},
      customSessionLabels: {},
      sessionLastActivity: {
        'agent:main:subagent:uuid': 1,
        'agent:main:dingtalk:group:123': 2,
        'agent:employee-old:session-visible': 3,
      },
      sessionWorkspaceIds: {},
    });

    expect(merged.map((session) => session.key)).toEqual(['agent:employee-old:session-visible']);
  });

  it('appends local-only summaries missing from Gateway list', () => {
    const gatewaySessions: ChatSession[] = [{ key: 'agent:main:main' }];
    const localSessions: ChatSession[] = [
      { key: 'agent:main:main', label: 'Main chat' },
      { key: 'agent:employee-old:session-archived', label: 'Archived chat' },
    ];

    const merged = appendLocalOnlySessionSummaries(gatewaySessions, localSessions);
    expect(merged.map((session) => session.key)).toEqual([
      'agent:main:main',
      'agent:employee-old:session-archived',
    ]);
  });
});
