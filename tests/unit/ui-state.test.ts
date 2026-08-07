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
        sessionPinnedAt: { 'agent:main:session-a': 1000 },
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
        sessionPinnedAt: { 'agent:main:session-b': 2000 },
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
        sessionPinnedAt: { 'agent:main:session-a': 1000 },
      },
    });

    const merged = mergeUiState(base, patch);
    expect(merged.workspaces.temporaryWorkspaces.map((entry) => entry.id)).toEqual(['temp-1']);
    expect(merged.chat.sessionWorkspaceIds['agent:main:session-b']).toBeUndefined();
  });

  it('preserves retired digital employee sessions through normalize and merge', () => {
    const withRetiredAgents = normalizeUiState({
      version: 1,
      updatedAt: 1,
      digitalEmployees: {
        cachedDisplayMetadata: {
          '16': {
            version: '1.0.4',
            name: '招聘数字员工',
          },
        },
        retiredAgents: {
          'employee-recruitment-specialist-183d7da3': {
            agentId: 'employee-recruitment-specialist-183d7da3',
            name: '招聘数字员工',
            marketEmployeeId: '16',
            retiredAt: '2026-07-15T06:00:00.000Z',
            readOnly: true,
          },
          'employee-recruitment-specialist-9498d361': {
            agentId: 'employee-recruitment-specialist-9498d361',
            name: '招聘数字员工',
            marketEmployeeId: '16',
            retiredAt: '2026-07-15T06:00:00.000Z',
            readOnly: false,
          },
        },
      },
    });

    expect(withRetiredAgents.digitalEmployees.retiredAgents).toEqual({
      'employee-recruitment-specialist-183d7da3': {
        agentId: 'employee-recruitment-specialist-183d7da3',
        name: '招聘数字员工',
        marketEmployeeId: '16',
        retiredAt: '2026-07-15T06:00:00.000Z',
      },
      'employee-recruitment-specialist-9498d361': {
        agentId: 'employee-recruitment-specialist-9498d361',
        name: '招聘数字员工',
        marketEmployeeId: '16',
        retiredAt: '2026-07-15T06:00:00.000Z',
        readOnly: false,
      },
    });

    const base = normalizeUiState({
      digitalEmployees: {
        cachedDisplayMetadata: {},
        retiredAgents: {},
      },
    });
    const merged = mergeUiState(base, withRetiredAgents);
    expect(merged.digitalEmployees.retiredAgents['employee-recruitment-specialist-183d7da3']).toMatchObject({
      name: '招聘数字员工',
      marketEmployeeId: '16',
    });
    expect(merged.digitalEmployees.retiredAgents['employee-recruitment-specialist-9498d361']).toMatchObject({
      readOnly: false,
    });
  });

  it('drops invalid retired agent records during normalize', () => {
    const normalized = normalizeUiState({
      digitalEmployees: {
        retiredAgents: {
          'employee-recruitment-specialist-abc': {
            agentId: 'employee-recruitment-specialist-wrong-id',
            name: '招聘数字员工',
            retiredAt: '2026-07-15T06:00:00.000Z',
          },
          main: {
            agentId: 'main',
            name: 'main',
            retiredAt: '2026-07-15T06:00:00.000Z',
          },
        },
      },
    });

    expect(normalized.digitalEmployees.retiredAgents).toEqual({});
  });

  it('preserves mySkillOrder when skills patch only updates display metadata', () => {
    const base = normalizeUiState({
      skills: {
        cachedDisplayMetadata: {
          'skill-a': { name: 'Alpha' },
        },
        mySkillOrder: ['skill-c', 'skill-a', 'skill-b'],
      },
    });

    const patch = {
      skills: {
        cachedDisplayMetadata: {
          'skill-a': { name: 'Alpha', version: '2.0.0' },
          'skill-b': { name: 'Beta' },
        },
      },
    };

    const merged = mergeUiState(base, patch);
    expect(merged.skills.mySkillOrder).toEqual(['skill-c', 'skill-a', 'skill-b']);
    expect(merged.skills.cachedDisplayMetadata['skill-a']?.version).toBe('2.0.0');
  });

  it('updates mySkillOrder when patch explicitly includes mySkillOrder', () => {
    const base = normalizeUiState({
      skills: {
        cachedDisplayMetadata: {
          'skill-a': { name: 'Alpha' },
        },
        mySkillOrder: ['skill-a', 'skill-b'],
      },
    });

    const merged = mergeUiState(base, {
      skills: {
        mySkillOrder: ['skill-b', 'skill-a'],
      },
    });

    expect(merged.skills.mySkillOrder).toEqual(['skill-b', 'skill-a']);
    expect(merged.skills.cachedDisplayMetadata['skill-a']?.name).toBe('Alpha');
  });

  it('preserves myEmployeeOrder when digitalEmployees patch only updates display metadata', () => {
    const base = normalizeUiState({
      digitalEmployees: {
        cachedDisplayMetadata: {
          '7': { name: 'Alpha Employee' },
        },
        retiredAgents: {},
        myEmployeeOrder: ['emp-c', 'emp-a', 'emp-b'],
      },
    });

    const patch = {
      digitalEmployees: {
        cachedDisplayMetadata: {
          '7': { name: 'Alpha Employee', version: '2.0.0' },
          '8': { name: 'Beta Employee' },
        },
      },
    };

    const merged = mergeUiState(base, patch);
    expect(merged.digitalEmployees.myEmployeeOrder).toEqual(['emp-c', 'emp-a', 'emp-b']);
    expect(merged.digitalEmployees.cachedDisplayMetadata['7']?.version).toBe('2.0.0');
  });

  it('updates myEmployeeOrder when patch explicitly includes myEmployeeOrder', () => {
    const base = normalizeUiState({
      digitalEmployees: {
        cachedDisplayMetadata: {
          '7': { name: 'Alpha Employee' },
        },
        retiredAgents: {},
        myEmployeeOrder: ['emp-a', 'emp-b'],
      },
    });

    const merged = mergeUiState(base, {
      digitalEmployees: {
        myEmployeeOrder: ['emp-b', 'emp-a'],
      },
    });

    expect(merged.digitalEmployees.myEmployeeOrder).toEqual(['emp-b', 'emp-a']);
    expect(merged.digitalEmployees.cachedDisplayMetadata['7']?.name).toBe('Alpha Employee');
  });
});
