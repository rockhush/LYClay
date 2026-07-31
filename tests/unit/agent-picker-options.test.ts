import { describe, expect, it } from 'vitest';
import { filterAgentsForAgentPicker, resolveAgentPickerLabel } from '../../src/lib/agent-picker-options';

describe('filterAgentsForAgentPicker', () => {
  const agents = [
    { id: 'main', name: 'Main Agent' },
    { id: 'dingtalk', name: 'dingtalk' },
    {
      id: 'employee-recruit-active',
      name: '招聘数字员工',
      isDigitalEmployee: true,
    },
    { id: 'employee-recruit-old-1', name: '招聘数字员工' },
    { id: 'employee-recruit-old-2', name: '招聘数字员工' },
    { id: 'employee-dqe-active', name: 'DQE质量流程数字员工', isDigitalEmployee: true },
    { id: 'employee-dqe-old', name: 'DQE质量流程数字员工' },
  ];

  it('keeps non-digital-employee agents and only installed digital employees', () => {
    const filtered = filterAgentsForAgentPicker(agents);
    expect(filtered.map((agent) => agent.id)).toEqual([
      'main',
      'dingtalk',
      'employee-recruit-active',
      'employee-dqe-active',
    ]);
  });

  it('dedupes display names after filtering', () => {
    const filtered = filterAgentsForAgentPicker(agents);
    expect(filtered.filter((agent) => agent.name === '招聘数字员工')).toHaveLength(1);
  });

  it('keeps a bound historical agent visible when explicitly included', () => {
    const filtered = filterAgentsForAgentPicker(agents, {
      includeAgentIds: ['employee-recruit-old-1'],
    });
    expect(filtered.map((agent) => agent.id)).toContain('employee-recruit-old-1');
  });
});

describe('resolveAgentPickerLabel', () => {
  const agents = [
    { id: 'main', name: 'Main Agent' },
    { id: 'employee-recruit-old-1', name: '招聘数字员工' },
  ];

  it('returns agent name when found', () => {
    expect(resolveAgentPickerLabel('employee-recruit-old-1', agents)).toBe('招聘数字员工');
  });

  it('does not show raw employee id suffix when name is missing', () => {
    expect(resolveAgentPickerLabel('employee-recruit-abc12345', [])).toBe('recruit');
  });
});
