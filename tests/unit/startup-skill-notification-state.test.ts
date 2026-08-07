import { describe, expect, it } from 'vitest';
import { hasPendingStartupSkillNotifications } from '@/lib/startup-skill-notification-state';

describe('hasPendingStartupSkillNotifications', () => {
  it('returns false before detection is ready', () => {
    expect(hasPendingStartupSkillNotifications({
      ready: false,
      updatable: [{ slug: '1', name: 'A', latestVersion: '1.0.0' }],
      newSkills: [],
    })).toBe(false);
  });

  it('returns false when there are no pending items', () => {
    expect(hasPendingStartupSkillNotifications({
      ready: true,
      updatable: [],
      newSkills: [],
    })).toBe(false);
  });

  it('returns true when updates or new skills are pending', () => {
    expect(hasPendingStartupSkillNotifications({
      ready: true,
      updatable: [{ slug: '1', name: 'A', latestVersion: '1.0.0' }],
      newSkills: [],
    })).toBe(true);
    expect(hasPendingStartupSkillNotifications({
      ready: true,
      updatable: [],
      newSkills: [{ slug: '9', name: 'B' }],
    })).toBe(true);
  });
});
