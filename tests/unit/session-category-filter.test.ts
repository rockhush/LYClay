import { describe, expect, it } from 'vitest';
import {
  isNormalChatSessionKey,
  matchesSidebarSessionCategoryFilter,
} from '../../src/lib/session-category-filter';

describe('session-category-filter', () => {
  it('isNormalChatSessionKey matches session- suffix only', () => {
    expect(isNormalChatSessionKey('agent:main:session-1783044835567')).toBe(true);
    expect(isNormalChatSessionKey('agent:main:cron:job-a')).toBe(false);
    expect(isNormalChatSessionKey('agent:main:alpha-session')).toBe(false);
    expect(isNormalChatSessionKey('agent:main:scheduled-task:job-a:run-1')).toBe(false);
  });

  it('matchesSidebarSessionCategoryFilter partitions cron and session keys', () => {
    const normal = 'agent:main:session-123';
    const cron = 'agent:main:scheduled-task:job-a:run-1';

    expect(matchesSidebarSessionCategoryFilter(normal, 'all')).toBe(true);
    expect(matchesSidebarSessionCategoryFilter(cron, 'all')).toBe(true);

    expect(matchesSidebarSessionCategoryFilter(normal, 'session')).toBe(true);
    expect(matchesSidebarSessionCategoryFilter(cron, 'session')).toBe(false);

    expect(matchesSidebarSessionCategoryFilter(normal, 'cron')).toBe(false);
    expect(matchesSidebarSessionCategoryFilter(cron, 'cron')).toBe(true);
  });
});
