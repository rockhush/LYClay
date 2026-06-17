import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearSkillUpdateFailed,
  clearSkillUpdateFailedForSkill,
  isSkillUpdateFailed,
  isSkillUpdateFailedForSkill,
  markSkillUpdateFailed,
  markSkillUpdateFailedForSkill,
  resetSkillUpdateFailuresForTests,
  subscribeSkillUpdateFailures,
} from '@/lib/skill-update-failure-session';

describe('skill-update-failure-session', () => {
  beforeEach(() => {
    resetSkillUpdateFailuresForTests();
  });

  it('tracks failed update slugs in memory until cleared', () => {
    markSkillUpdateFailed('office-assistant');
    expect(isSkillUpdateFailed('office-assistant')).toBe(true);
    clearSkillUpdateFailed('office-assistant');
    expect(isSkillUpdateFailed('office-assistant')).toBe(false);
  });

  it('notifies subscribers when failure state changes', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSkillUpdateFailures(listener);

    markSkillUpdateFailed('ppt-maker');
    expect(listener).toHaveBeenCalledTimes(1);

    clearSkillUpdateFailed('ppt-maker');
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    markSkillUpdateFailed('ppt-maker');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('tracks marketplace id and slug aliases together', () => {
    markSkillUpdateFailedForSkill({ id: 7, slug: 'office-assistant' });
    expect(isSkillUpdateFailedForSkill({ id: 7, slug: 'office-assistant' })).toBe(true);
    expect(isSkillUpdateFailed('office-assistant')).toBe(true);
    expect(isSkillUpdateFailed('7')).toBe(true);

    clearSkillUpdateFailedForSkill({ id: 7, slug: 'office-assistant' });
    expect(isSkillUpdateFailedForSkill({ id: 7, slug: 'office-assistant' })).toBe(false);
  });
});
