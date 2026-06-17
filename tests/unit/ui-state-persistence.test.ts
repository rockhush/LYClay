import { describe, expect, it } from 'vitest';
import {
  isNonEmptyChatState,
  isNonEmptyWorkspaceState,
  mergeHydratedUiState,
  type LyclawUiState,
} from '../../src/lib/ui-state-persistence';

const emptyLocal: LyclawUiState = {
  version: 1,
  updatedAt: 1,
  workspaces: {
    currentWorkspaceId: null,
    currentWorkspacePath: null,
    temporaryWorkspaces: [],
  },
  chat: {
    sessionWorkspaceIds: {},
    customSessionLabels: {},
    sessionPinnedAt: {},
    sessionLastActivity: {},
    sessionCompressionState: {},
  },
  skills: {
    cachedDisplayMetadata: {},
  },
  digitalEmployees: {
    cachedDisplayMetadata: {},
  },
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
  skills: {
    cachedDisplayMetadata: {},
  },
  digitalEmployees: {
    cachedDisplayMetadata: {},
  },
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
        sessionWorkspaceIds: {},
        customSessionLabels: {},
        sessionPinnedAt: {
          'agent:main:session-a': 2000,
          'agent:main:session-b': 3000,
        },
        sessionLastActivity: {},
        sessionCompressionState: {},
      },
      skills: {
        cachedDisplayMetadata: {},
      },
      digitalEmployees: {
        cachedDisplayMetadata: {},
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
});
