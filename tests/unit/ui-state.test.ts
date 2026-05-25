import { describe, expect, it } from 'vitest';
import { mergeUiState, normalizeUiState } from '../../electron/utils/ui-state';

describe('ui-state persistence', () => {
  it('replaces workspace folders when patch includes workspaces', () => {
    const base = normalizeUiState({
      version: 1,
      updatedAt: 1,
      workspaces: {
        currentWorkspaceId: 'temp-1',
        currentWorkspacePath: 'C:\\one',
        temporaryWorkspaces: [{
          id: 'temp-1',
          name: 'one',
          agentId: 'temp',
          agentName: 'one',
          path: 'C:\\one',
          createdAt: 1,
          lastAccessedAt: 1,
        }],
      },
      chat: {
        sessionWorkspaceIds: { 'agent:main:session-a': 'temp-1' },
        customSessionLabels: {},
      },
    });

    const patch = normalizeUiState({
      workspaces: {
        currentWorkspaceId: 'temp-2',
        currentWorkspacePath: 'C:\\two',
        temporaryWorkspaces: [{
          id: 'temp-2',
          name: 'two',
          agentId: 'temp',
          agentName: 'two',
          path: 'C:\\two',
          createdAt: 2,
          lastAccessedAt: 2,
        }],
      },
      chat: {
        sessionWorkspaceIds: { 'agent:main:session-b': 'temp-2' },
        customSessionLabels: { 'agent:main:session-b': 'B' },
      },
    });

    const merged = mergeUiState(base, patch);
    expect(merged.workspaces.temporaryWorkspaces.map((entry) => entry.id)).toEqual(['temp-2']);
    expect(merged.workspaces.currentWorkspaceId).toBe('temp-2');
    expect(merged.chat.sessionWorkspaceIds['agent:main:session-a']).toBeUndefined();
    expect(merged.chat.sessionWorkspaceIds['agent:main:session-b']).toBe('temp-2');
    expect(merged.chat.customSessionLabels['agent:main:session-b']).toBe('B');
  });

  it('preserves removed workspaces as deleted when patch omits them', () => {
    const base = normalizeUiState({
      workspaces: {
        currentWorkspaceId: 'temp-1',
        currentWorkspacePath: 'C:\\one',
        temporaryWorkspaces: [
          {
            id: 'temp-1',
            name: 'one',
            agentId: 'temp',
            agentName: 'one',
            path: 'C:\\one',
            createdAt: 1,
            lastAccessedAt: 1,
          },
          {
            id: 'temp-2',
            name: 'two',
            agentId: 'temp',
            agentName: 'two',
            path: 'C:\\two',
            createdAt: 2,
            lastAccessedAt: 2,
          },
        ],
      },
      chat: {
        sessionWorkspaceIds: {
          'agent:main:session-a': 'temp-1',
          'agent:main:session-b': 'temp-2',
        },
        customSessionLabels: {},
      },
    });

    const patch = normalizeUiState({
      workspaces: {
        currentWorkspaceId: 'temp-1',
        currentWorkspacePath: 'C:\\one',
        temporaryWorkspaces: [{
          id: 'temp-1',
          name: 'one',
          agentId: 'temp',
          agentName: 'one',
          path: 'C:\\one',
          createdAt: 1,
          lastAccessedAt: 1,
        }],
      },
      chat: {
        sessionWorkspaceIds: { 'agent:main:session-a': 'temp-1' },
        customSessionLabels: {},
      },
    });

    const merged = mergeUiState(base, patch);
    expect(merged.workspaces.temporaryWorkspaces.map((entry) => entry.id)).toEqual(['temp-1']);
    expect(merged.chat.sessionWorkspaceIds['agent:main:session-b']).toBeUndefined();
  });
});
