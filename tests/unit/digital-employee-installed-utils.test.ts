import { describe, expect, it } from 'vitest';
import {
  groupInstalledEmployeesByMarketId,
  mapInstalledEmployeeToMyAgent,
} from '@/pages/DigitalEmployee/installed-employee-utils';
import type { LocalDigitalEmployee } from '@/types/digital-employee';

function createEmployee(overrides: Partial<LocalDigitalEmployee> = {}): LocalDigitalEmployee {
  return {
    instanceId: 'document-analyst--abc',
    marketEmployeeId: '7',
    packageId: 'com.lyclaw.employee.document-analyst',
    packageVersion: '1.0.1',
    name: '文档分析数字员工',
    description: '分析本地文档，提炼事实并生成结构化报告。',
    tags: ['文档分析', '内容总结', '报告生成'],
    installPath: '/tmp/document-analyst--abc',
    agentId: 'employee-document-analyst-abc',
    sessionKey: 'agent:employee-document-analyst-abc:main',
    status: 'active',
    enabled: true,
    warnings: [],
    ...overrides,
  };
}

describe('installed employee utils', () => {
  it('always uses marketplace catalog fields for display, ignoring local manifest', () => {
    const mapped = mapInstalledEmployeeToMyAgent(createEmployee(), {
      slug: '7',
      name: 'test11',
      description: 'plaza description',
      version: '1.0.0',
      author: '龙鸣',
      downloads: 1,
      updateTime: '',
      category: 'rnd',
      installed: true,
      tags: ['test'],
    });

    expect(mapped.name).toBe('test11');
    expect(mapped.description).toBe('plaza description');
    expect(mapped.version).toBe('1.0.0');
    expect(mapped.tags).toEqual(['test']);
    expect(mapped.author).toBe('龙鸣');
    // Local-only runtime fields are always preserved.
    expect(mapped.sessionKey).toBe('agent:employee-document-analyst-abc:main');
    expect(mapped.id).toBe('document-analyst--abc');
  });

  it('does not fall back to local manifest fields when the marketplace value is empty', () => {
    const mapped = mapInstalledEmployeeToMyAgent(createEmployee(), {
      slug: '7',
      name: 'test11',
      description: '',
      version: '1.0.0',
      author: '龙鸣',
      downloads: 1,
      updateTime: '',
      category: 'rnd',
      installed: true,
      tags: [],
    });

    expect(mapped.name).toBe('test11');
    // Marketplace description is empty -> stays empty, never the local manifest.
    expect(mapped.description).toBe('');
    expect(mapped.tags).toEqual([]);
  });

  it('uses no display fields when there is no marketplace entry', () => {
    const mapped = mapInstalledEmployeeToMyAgent(createEmployee());

    expect(mapped.name).toBe('');
    expect(mapped.description).toBe('');
    expect(mapped.version).toBe('');
    expect(mapped.tags).toEqual([]);
    // Runtime fields still come from the local install record.
    expect(mapped.sessionKey).toBe('agent:employee-document-analyst-abc:main');
    expect(mapped.id).toBe('document-analyst--abc');
  });

  it('groups multiple local installs that share a marketplace id', () => {
    const grouped = groupInstalledEmployeesByMarketId([
      createEmployee(),
      createEmployee({
        instanceId: 'test11--def',
        packageId: 'com.lyclaw.employee.test11',
        name: 'test11',
        agentId: 'employee-test11-def',
        sessionKey: 'agent:employee-test11-def:main',
      }),
    ]);

    expect(grouped.get('7')).toHaveLength(2);
  });
});
