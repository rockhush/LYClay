import { describe, expect, it, beforeEach } from 'vitest';
import {
  commitCachedDigitalEmployeeDisplayMetadata,
  loadDigitalEmployeeDisplayCache,
  resolveCachedDigitalEmployeeDisplayMetadata,
  resolveInstalledDigitalEmployeeForDisplay,
  seedCachedDigitalEmployeeDisplayMetadata,
} from '@/lib/digital-employee-display-cache';

describe('digital-employee-display-cache', () => {
  beforeEach(() => {
    loadDigitalEmployeeDisplayCache({ cachedDisplayMetadata: {} });
  });

  it('seeds metadata from API only once', () => {
    expect(seedCachedDigitalEmployeeDisplayMetadata('42', {
      name: '采购询价与比价专员',
      version: '1.0.0',
      author: '龙鸣',
      description: 'Review procurement requirements and supplier quotes.',
      updateTime: '2026-06-08',
      tags: ['采购', '比价'],
    })).toBe(true);

    expect(resolveCachedDigitalEmployeeDisplayMetadata('42')).toEqual({
      name: '采购询价与比价专员',
      version: '1.0.0',
      author: '龙鸣',
      description: 'Review procurement requirements and supplier quotes.',
      updateTime: '2026-06-08',
      tags: ['采购', '比价'],
    });

    expect(seedCachedDigitalEmployeeDisplayMetadata('42', {
      name: 'Updated name',
      version: '2.0.0',
    })).toBe(false);
    expect(resolveCachedDigitalEmployeeDisplayMetadata('42')?.name).toBe('采购询价与比价专员');
  });

  it('commits metadata after install or update', () => {
    expect(commitCachedDigitalEmployeeDisplayMetadata('99', {
      name: '领益智造每日情报推送助手',
      version: '1.0.1',
      author: '领益AI开发团队',
      description: 'Push daily intelligence.',
    })).toBe(true);

    expect(resolveCachedDigitalEmployeeDisplayMetadata('99')?.version).toBe('1.0.1');
  });

  it('falls back to cached metadata when marketplace data is missing', () => {
    loadDigitalEmployeeDisplayCache({
      cachedDisplayMetadata: {
        '12': {
          name: 'Cached Agent',
          description: 'Cached description',
          version: '1.0.0',
          author: 'Alice',
        },
      },
    });

    expect(resolveInstalledDigitalEmployeeForDisplay('12')).toEqual({
      name: 'Cached Agent',
      description: 'Cached description',
      version: '1.0.0',
      author: 'Alice',
      updateTime: '',
      tags: [],
    });
  });
});
