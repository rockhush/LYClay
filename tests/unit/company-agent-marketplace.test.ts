import { describe, expect, it } from 'vitest';
import {
  mapCompanyAgentRecord,
  parseAgentRecords,
  sortMarketplaceAgents,
  type MarketplaceAgentResult,
} from '../../electron/utils/company-agent-marketplace';

describe('company-agent-marketplace', () => {
  const sampleAgents: MarketplaceAgentResult[] = [
    {
      slug: '1',
      name: '采购询价与比价专员',
      description: 'desc-a',
      version: '1.0.0',
      author: '龙鸣',
      downloads: 98,
      updateTime: '2026-06-17',
      category: 'procurement',
      tags: [],
      installed: false,
    },
    {
      slug: '2',
      name: '财务分析助手',
      description: 'desc-b',
      version: '1.0.0',
      author: '张三',
      downloads: 186,
      updateTime: '2026-07-09',
      category: 'finance',
      tags: [],
      installed: false,
    },
    {
      slug: '3',
      name: '人力招聘助手',
      description: 'desc-c',
      version: '1.0.0',
      author: '李四',
      downloads: 93,
      updateTime: '2026-06-11 10:14:10',
      category: 'hr',
      tags: [],
      installed: false,
    },
  ];

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

  it('sorts marketplace agents by download count descending', () => {
    const sorted = sortMarketplaceAgents(sampleAgents, '-download_count');
    expect(sorted.map((agent) => agent.slug)).toEqual(['2', '1', '3']);
  });

  it('sorts marketplace agents by update time descending', () => {
    const sorted = sortMarketplaceAgents(sampleAgents, '-update_time');
    expect(sorted.map((agent) => agent.slug)).toEqual(['2', '1', '3']);
  });
});
