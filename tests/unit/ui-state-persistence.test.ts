import { describe, expect, it } from 'vitest';
import {
  isNonEmptyChatState,
  isNonEmptyWorkspaceState,
  mergeHydratedUiState,
  type LyclawUiState,
} from '../../src/lib/ui-state-persistence';

const emptyChat: LyclawUiState['chat'] = {
  sessionWorkspaceIds: {},
  customSessionLabels: {},
  sessionPinnedAt: {},
  sessionLastActivity: {},
  sessionCompressionState: {},
};

const emptySkills: LyclawUiState['skills'] = {
  cachedDisplayMetadata: {},
};

const emptyDigitalEmployees: LyclawUiState['digitalEmployees'] = {
  cachedDisplayMetadata: {},
  retiredAgents: {},
};

const emptyLocal: LyclawUiState = {
  version: 1,
  updatedAt: 1,
  workspaces: {
    currentWorkspaceId: null,
    currentWorkspacePath: null,
    temporaryWorkspaces: [],
  },
  chat: emptyChat,
  skills: emptySkills,
  digitalEmployees: emptyDigitalEmployees,
};

const diskWithWorkspace: LyclawUiState = {
  version: 1,
  updatedAt: 2,
  workspaces: {
    currentWorkspaceId: 'temp-1',
    currentWorkspacePath: '/Users/demo/project',
    temporaryWorkspaces: [{
      id: 'temp-1',
      name: 'Demo',
      agentId: 'temp',
      agentName: 'Demo',
      path: '/Users/demo/project',
      createdAt: 1,
      lastAccessedAt: 1,
    }],
  },
  chat: {
    sessionWorkspaceIds: { 'agent:main:session-a': 'temp-1' },
    customSessionLabels: { 'agent:main:session-a': 'My chat' },
    sessionPinnedAt: { 'agent:main:session-a': 1000 },
    sessionLastActivity: {},
    sessionCompressionState: {},
  },
  skills: emptySkills,
  digitalEmployees: emptyDigitalEmployees,
};

describe('ui-state persistence hydrate merge', () => {
  it('detects empty workspace snapshots', () => {
    expect(isNonEmptyWorkspaceState(emptyLocal.workspaces)).toBe(false);
    expect(isNonEmptyWorkspaceState(diskWithWorkspace.workspaces)).toBe(true);
  });

  it('detects empty chat snapshots', () => {
    expect(isNonEmptyChatState(emptyLocal.chat)).toBe(false);
    expect(isNonEmptyChatState(diskWithWorkspace.chat)).toBe(true);
  });

  it('restores workspaces from disk when local snapshot is empty after reinstall', () => {
    const merged = mergeHydratedUiState(diskWithWorkspace, emptyLocal, {
      preferLocalWorkspaces: false,
      preferLocalChat: false,
    });

    expect(merged.workspaces.temporaryWorkspaces.map((entry) => entry.id)).toEqual(['temp-1']);
    expect(merged.chat.sessionWorkspaceIds['agent:main:session-a']).toBe('temp-1');
    expect(merged.chat.customSessionLabels['agent:main:session-a']).toBe('My chat');
    expect(merged.chat.sessionPinnedAt['agent:main:session-a']).toBe(1000);
  });

  it('prefers non-empty local workspace data during normal upgrades', () => {
    const localWithWorkspace: LyclawUiState = {
      ...emptyLocal,
      workspaces: {
        currentWorkspaceId: 'temp-2',
        currentWorkspacePath: '/Users/demo/other',
        temporaryWorkspaces: [{
          id: 'temp-2',
          name: 'Other',
          agentId: 'temp',
          agentName: 'Other',
          path: '/Users/demo/other',
          createdAt: 3,
          lastAccessedAt: 3,
        }],
      },
    };

    const merged = mergeHydratedUiState(diskWithWorkspace, localWithWorkspace, {
      preferLocalWorkspaces: true,
      preferLocalChat: true,
    });

    expect(merged.workspaces.temporaryWorkspaces.map((entry) => entry.id)).toEqual(['temp-2']);
  });

  it('merges pinned session metadata with local precedence', () => {
    const localWithPinnedSession: LyclawUiState = {
      ...emptyLocal,
      chat: {
        ...emptyChat,
        sessionPinnedAt: {
          'agent:main:session-a': 2000,
          'agent:main:session-b': 3000,
        },
      },
    };

    const merged = mergeHydratedUiState(diskWithWorkspace, localWithPinnedSession, {
      preferLocalWorkspaces: false,
      preferLocalChat: false,
    });

    expect(merged.chat.sessionPinnedAt).toEqual({
      'agent:main:session-a': 2000,
      'agent:main:session-b': 3000,
    });
  });

  it('restores mySkillOrder from disk when local snapshot has none', () => {
    const diskWithSkillOrder: LyclawUiState = {
      ...diskWithWorkspace,
      skills: {
        cachedDisplayMetadata: { 'skill-a': { name: 'Alpha' } },
        mySkillOrder: ['skill-b', 'skill-a'],
      },
    };

    const merged = mergeHydratedUiState(diskWithSkillOrder, emptyLocal, {
      preferLocalWorkspaces: false,
      preferLocalChat: false,
    });

    expect(merged.skills.mySkillOrder).toEqual(['skill-b', 'skill-a']);
    expect(merged.skills.cachedDisplayMetadata['skill-a']?.name).toBe('Alpha');
  });

  it('restores myEmployeeOrder from disk when local snapshot has none', () => {
    const diskWithEmployeeOrder: LyclawUiState = {
      ...diskWithWorkspace,
      digitalEmployees: {
        cachedDisplayMetadata: { '7': { name: 'Alpha Employee' } },
        retiredAgents: {},
        myEmployeeOrder: ['emp-b', 'emp-a'],
      },
    };

    const merged = mergeHydratedUiState(diskWithEmployeeOrder, emptyLocal, {
      preferLocalWorkspaces: false,
      preferLocalChat: false,
    });

    expect(merged.digitalEmployees.myEmployeeOrder).toEqual(['emp-b', 'emp-a']);
    expect(merged.digitalEmployees.cachedDisplayMetadata['7']?.name).toBe('Alpha Employee');
  });
});
