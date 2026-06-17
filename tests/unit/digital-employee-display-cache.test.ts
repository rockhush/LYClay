import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildMarketplaceAgentFromCache,
  resetDigitalEmployeeDisplayCacheForTests,
  resolveMarketplaceAgentWithCache,
  seedCachedDigitalEmployeeDisplayMetadata,
} from '@/lib/digital-employee-display-cache';

describe('digital-employee-display-cache', () => {
  beforeEach(() => {
    resetDigitalEmployeeDisplayCacheForTests();
  });

  it('seeds and resolves cached marketplace display metadata by slug', () => {
    seedCachedDigitalEmployeeDisplayMetadata([{
      slug: 'office-assistant',
      name: '办公助手',
      description: '处理日程与消息',
      version: '1.0.0',
      author: '彭雪',
      updateTime: '2026-06-01',
      category: 'office',
      tags: ['办公'],
    }]);

    expect(buildMarketplaceAgentFromCache('office-assistant')).toMatchObject({
      slug: 'office-assistant',
      name: '办公助手',
      description: '处理日程与消息',
      version: '1.0.0',
      author: '彭雪',
      tags: ['办公'],
    });
  });

  it('prefers live marketplace data over cache', () => {
    seedCachedDigitalEmployeeDisplayMetadata([{
      slug: 'office-assistant',
      name: '旧名称',
      description: '旧描述',
      version: '1.0.0',
      author: '旧作者',
      updateTime: '',
      category: 'office',
      tags: [],
    }]);

    expect(resolveMarketplaceAgentWithCache('office-assistant', {
      slug: 'office-assistant',
      name: '办公助手',
      description: '新描述',
      version: '1.0.1',
      author: '彭雪',
      downloads: 1,
      updateTime: '',
      category: 'office',
      installed: true,
      tags: ['办公'],
    })).toMatchObject({
      name: '办公助手',
      description: '新描述',
      version: '1.0.1',
    });
  });
});
