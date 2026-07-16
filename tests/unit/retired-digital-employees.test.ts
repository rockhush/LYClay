import { beforeEach, describe, expect, it } from 'vitest';
import {
  isRetiredDigitalEmployeeAgent,
  loadRetiredDigitalEmployees,
  resolveActiveDigitalEmployeeExecutionAgent,
  resolveAgentDisplayName,
  retireDigitalEmployee,
  retireDigitalEmployeesByMarketId,
  unretireDigitalEmployee,
  unretireDigitalEmployeesByMarketId,
} from '@/lib/retired-digital-employees';

describe('retired-digital-employees', () => {
  beforeEach(() => {
    loadRetiredDigitalEmployees({ retiredAgents: {} });
  });

  it('resolves display name from retired registry when agent is uninstalled', () => {
    retireDigitalEmployee({
      agentId: 'employee-recruitment-specialist-128348c9',
      name: '招聘数字员工',
      marketEmployeeId: 'employee-recruitment-specialist',
    });

    expect(resolveAgentDisplayName('employee-recruitment-specialist-128348c9', {
      agents: [],
      digitalEmployees: [],
    })).toBe('招聘数字员工');
  });

  it('prefers active agent and employee names over retired registry', () => {
    retireDigitalEmployee({
      agentId: 'employee-recruitment-specialist-128348c9',
      name: '旧名称',
    });

    expect(resolveAgentDisplayName('employee-recruitment-specialist-128348c9', {
      agents: [{ id: 'employee-recruitment-specialist-128348c9', name: '招聘数字员工' }],
      digitalEmployees: [],
    })).toBe('招聘数字员工');
  });

  it('marks only registered retired agents as read-only targets', () => {
    retireDigitalEmployee({
      agentId: 'employee-recruitment-specialist-128348c9',
      name: '招聘数字员工',
    });

    expect(isRetiredDigitalEmployeeAgent('employee-recruitment-specialist-128348c9')).toBe(true);
    expect(isRetiredDigitalEmployeeAgent('main')).toBe(false);
    expect(isRetiredDigitalEmployeeAgent('some-custom-agent')).toBe(false);
  });

  it('clears retired registry when the same agent id is reinstalled', () => {
    retireDigitalEmployee({
      agentId: 'employee-recruitment-specialist-128348c9',
      name: '招聘数字员工',
    });
    expect(unretireDigitalEmployee('employee-recruitment-specialist-128348c9')).toBe(true);
    expect(isRetiredDigitalEmployeeAgent('employee-recruitment-specialist-128348c9')).toBe(false);
  });

  it('clears all retired agent ids for the same marketplace employee on reinstall', () => {
    retireDigitalEmployee({
      agentId: 'employee-recruitment-specialist-128348c9',
      name: '招聘数字员工',
      marketEmployeeId: 'employee-recruitment-specialist',
    });
    retireDigitalEmployee({
      agentId: 'employee-recruitment-specialist-abcdef01',
      name: '招聘数字员工',
      marketEmployeeId: 'employee-recruitment-specialist',
    });
    retireDigitalEmployee({
      agentId: 'employee-other-specialist-99999999',
      name: '其他岗位助理',
      marketEmployeeId: 'employee-other-specialist',
    });

    expect(unretireDigitalEmployeesByMarketId('employee-recruitment-specialist')).toBe(true);
    expect(isRetiredDigitalEmployeeAgent('employee-recruitment-specialist-128348c9')).toBe(false);
    expect(isRetiredDigitalEmployeeAgent('employee-recruitment-specialist-abcdef01')).toBe(false);
    expect(isRetiredDigitalEmployeeAgent('employee-other-specialist-99999999')).toBe(true);
    expect(resolveAgentDisplayName('employee-recruitment-specialist-128348c9', {
      agents: [],
      digitalEmployees: [],
    })).toBe('招聘数字员工');
  });

  it('re-retires all historical agent ids for the same marketplace employee on uninstall', () => {
    retireDigitalEmployee({
      agentId: 'employee-recruitment-specialist-session-a',
      name: '招聘数字员工',
      marketEmployeeId: 'employee-recruitment-specialist',
    });
    retireDigitalEmployee({
      agentId: 'employee-recruitment-specialist-session-b',
      name: '招聘数字员工',
      marketEmployeeId: 'employee-recruitment-specialist',
    });
    retireDigitalEmployee({
      agentId: 'employee-other-specialist-99999999',
      name: '其他岗位助理',
      marketEmployeeId: 'employee-other-specialist',
    });

    unretireDigitalEmployeesByMarketId('employee-recruitment-specialist');
    expect(isRetiredDigitalEmployeeAgent('employee-recruitment-specialist-session-a')).toBe(false);
    expect(isRetiredDigitalEmployeeAgent('employee-recruitment-specialist-session-b')).toBe(false);

    expect(retireDigitalEmployeesByMarketId('employee-recruitment-specialist')).toBe(true);
    expect(isRetiredDigitalEmployeeAgent('employee-recruitment-specialist-session-a')).toBe(true);
    expect(isRetiredDigitalEmployeeAgent('employee-recruitment-specialist-session-b')).toBe(true);
    expect(isRetiredDigitalEmployeeAgent('employee-other-specialist-99999999')).toBe(true);
  });

  it('reuses the installed sibling name for historical sessions after reinstall', () => {
    expect(resolveAgentDisplayName('employee-recruitment-specialist-8dce23b0', {
      agents: [],
      digitalEmployees: [{
        agentId: 'employee-recruitment-specialist-newid',
        name: '招聘数字员工',
      }],
    })).toBe('招聘数字员工');
  });

  it('maps historical session agent ids to the currently installed execution agent', () => {
    retireDigitalEmployee({
      agentId: 'employee-recruitment-specialist-8dce23b0',
      name: '招聘数字员工',
      marketEmployeeId: 'employee-recruitment-specialist',
    });
    unretireDigitalEmployeesByMarketId('employee-recruitment-specialist');

    expect(resolveActiveDigitalEmployeeExecutionAgent('employee-recruitment-specialist-8dce23b0', {
      agents: [{
        id: 'employee-recruitment-specialist-newid01',
        name: '招聘数字员工',
        isDigitalEmployee: true,
      }],
      digitalEmployees: [{
        agentId: 'employee-recruitment-specialist-newid01',
        name: '招聘数字员工',
        marketEmployeeId: 'employee-recruitment-specialist',
      }],
    })).toEqual({
      agentId: 'employee-recruitment-specialist-newid01',
      name: '招聘数字员工',
    });
  });

  it('resolves execution agent from installed digital employees when agents snapshot is stale', () => {
    expect(resolveActiveDigitalEmployeeExecutionAgent('employee-recruitment-specialist-8dce23b0', {
      agents: [],
      digitalEmployees: [{
        agentId: 'employee-recruitment-specialist-newid01',
        name: '招聘数字员工',
        marketEmployeeId: 'employee-recruitment-specialist',
      }],
    })).toEqual({
      agentId: 'employee-recruitment-specialist-newid01',
      name: '招聘数字员工',
    });
  });

  it('does not remap read-only retired sessions without an active reinstall', () => {
    retireDigitalEmployee({
      agentId: 'employee-recruitment-specialist-8dce23b0',
      name: '招聘数字员工',
      marketEmployeeId: 'employee-recruitment-specialist',
    });

    expect(resolveActiveDigitalEmployeeExecutionAgent('employee-recruitment-specialist-8dce23b0', {
      agents: [{
        id: 'employee-recruitment-specialist-newid01',
        name: '招聘数字员工',
        isDigitalEmployee: true,
      }],
      digitalEmployees: [{
        agentId: 'employee-recruitment-specialist-newid01',
        name: '招聘数字员工',
        marketEmployeeId: 'employee-recruitment-specialist',
      }],
    })).toBeNull();
  });

  it('does not remap non-digital custom agents', () => {
    expect(resolveActiveDigitalEmployeeExecutionAgent('research', {
      agents: [{ id: 'research', name: 'Research', isDigitalEmployee: true }],
      digitalEmployees: [],
    })).toEqual({
      agentId: 'research',
      name: 'Research',
    });
    expect(resolveActiveDigitalEmployeeExecutionAgent('research', {
      agents: [],
      digitalEmployees: [],
    })).toBeNull();
  });
});
