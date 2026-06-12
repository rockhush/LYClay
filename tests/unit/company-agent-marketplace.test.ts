import { describe, expect, it } from 'vitest';
import { mapCompanyAgentRecord, parseAgentRecords } from '../../electron/utils/company-agent-marketplace';

describe('company-agent-marketplace', () => {
  it('maps API agent records to marketplace cards', () => {
    const mapped = mapCompanyAgentRecord({
      id: 1,
      name: '财务分析助手',
      skill_detail: '专注于财务数据分析',
      version: '1.0.0',
      author: '张三',
      download_count: 156,
      category: 'finance',
      tags: ['财务', '分析', '报表'],
      create_time: '2026-06-11 10:14:10',
    });

    expect(mapped).toEqual({
      slug: '1',
      name: '财务分析助手',
      description: '专注于财务数据分析',
      version: '1.0.0',
      author: '张三',
      downloads: 156,
      updateTime: '2026-06-11 10:14:10',
      category: 'finance',
      tags: ['财务', '分析', '报表'],
      installed: false,
    });
  });

  it('parses success responses with data array', () => {
    const records = parseAgentRecords({
      status: 'success',
      data: [{ id: 2, name: '测试智能体' }],
    });

    expect(records).toHaveLength(1);
    expect(records[0]?.id).toBe(2);
  });
});
