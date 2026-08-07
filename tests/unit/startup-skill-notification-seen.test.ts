import { describe, expect, it } from 'vitest';
import {
  buildStartupSkillNotificationKey,
  buildStartupSkillNotificationKeys,
  evaluateStartupSkillNotification,
  hasUnseenStartupSkillNotifications,
  mergeSeenStartupSkillNotificationKeys,
} from '@/lib/startup-skill-notification-seen';
import type { NewSkillInfo, UpdatableSkillInfo } from '@/lib/skill-update-check';

const updatable = (slug: string, latestVersion: string, name = slug): UpdatableSkillInfo => ({
  slug,
  name,
  latestVersion,
});

const newSkill = (slug: string, name = slug): NewSkillInfo => ({
  slug,
  name,
});

describe('startup-skill-notification-seen', () => {
  it('builds stable keys for updates and new skills', () => {
    expect(buildStartupSkillNotificationKey('update', '71', '2.0.0')).toBe('update:71:2.0.0');
    expect(buildStartupSkillNotificationKey('new', '99')).toBe('new:99');
  });

  it('shows the first detected batch and remembers all current keys', () => {
    const current = evaluateStartupSkillNotification(
      [updatable('1', '1.1.0', 'xxx1'), updatable('2', '1.2.0', 'xxx2')],
      [newSkill('3', 'xxx3')],
      new Set(),
    );

    expect(current.shouldShow).toBe(true);
    expect(current.currentKeys).toEqual([
      'update:1:1.1.0',
      'update:2:1.2.0',
      'new:3',
    ]);
    expect(Array.from(current.nextSeenKeys)).toEqual(current.currentKeys);
  });

  it('does not show again when the same batch is still pending', () => {
    const seen = new Set(['update:1:1.1.0', 'update:2:1.2.0', 'new:3']);
    const current = evaluateStartupSkillNotification(
      [updatable('1', '1.1.0'), updatable('2', '1.2.0')],
      [newSkill('3')],
      seen,
    );

    expect(current.shouldShow).toBe(false);
    expect(current.nextSeenKeys).toEqual(seen);
  });

  it('shows pending plus newly detected entries after one item was handled', () => {
    const seen = new Set(['update:1:1.1.0', 'update:2:1.2.0', 'new:3']);
    const current = evaluateStartupSkillNotification(
      [updatable('2', '1.2.0'), updatable('4', '3.0.0', 'xxx4')],
      [newSkill('3')],
      seen,
    );

    expect(current.shouldShow).toBe(true);
    expect(current.currentKeys).toEqual([
      'update:2:1.2.0',
      'update:4:3.0.0',
      'new:3',
    ]);
    expect(hasUnseenStartupSkillNotifications(current.currentKeys, seen)).toBe(true);
    expect(mergeSeenStartupSkillNotificationKeys(seen, current.currentKeys)).toEqual(
      new Set(['update:1:1.1.0', 'update:2:1.2.0', 'new:3', 'update:4:3.0.0']),
    );
  });

  it('treats a newer version of the same skill as a new notification', () => {
    const seen = new Set(['update:71:1.0.0']);
    const current = evaluateStartupSkillNotification(
      [updatable('71', '2.0.0')],
      [],
      seen,
    );

    expect(current.shouldShow).toBe(true);
    expect(buildStartupSkillNotificationKeys([updatable('71', '2.0.0')], [])).toEqual(['update:71:2.0.0']);
  });

  it('does not show when there is nothing to notify', () => {
    const current = evaluateStartupSkillNotification([], [], new Set());
    expect(current.shouldShow).toBe(false);
    expect(current.currentKeys).toEqual([]);
  });
});
