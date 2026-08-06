import type { NewSkillInfo, UpdatableSkillInfo } from '@/lib/skill-update-check';

export const STARTUP_SKILL_NOTIFICATION_SEEN_KEY = 'LYClaw:skills:startup-notification-seen';

export function buildStartupSkillNotificationKey(
  variant: 'update' | 'new',
  slug: string,
  latestVersion?: string,
): string {
  const trimmedSlug = slug.trim();
  if (variant === 'update') {
    return `update:${trimmedSlug}:${(latestVersion ?? '').trim()}`;
  }
  return `new:${trimmedSlug}`;
}

export function buildStartupSkillNotificationKeys(
  updatable: UpdatableSkillInfo[],
  newSkills: NewSkillInfo[],
): string[] {
  return [
    ...updatable.map((item) => buildStartupSkillNotificationKey('update', item.slug, item.latestVersion)),
    ...newSkills.map((item) => buildStartupSkillNotificationKey('new', item.slug)),
  ];
}

export function loadSeenStartupSkillNotificationKeys(): Set<string> {
  if (typeof window === 'undefined' || !window.localStorage) {
    return new Set();
  }

  try {
    const raw = window.localStorage.getItem(STARTUP_SKILL_NOTIFICATION_SEEN_KEY);
    if (!raw) return new Set();

    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();

    return new Set(
      parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0),
    );
  } catch {
    return new Set();
  }
}

export function saveSeenStartupSkillNotificationKeys(keys: Set<string>): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return;
  }

  try {
    window.localStorage.setItem(
      STARTUP_SKILL_NOTIFICATION_SEEN_KEY,
      JSON.stringify(Array.from(keys)),
    );
  } catch {
    // Ignore quota / private-mode write failures.
  }
}

export function hasUnseenStartupSkillNotifications(
  currentKeys: string[],
  seenKeys: Set<string>,
): boolean {
  if (currentKeys.length === 0) return false;
  return currentKeys.some((key) => !seenKeys.has(key));
}

export function mergeSeenStartupSkillNotificationKeys(
  seenKeys: Set<string>,
  currentKeys: string[],
): Set<string> {
  return new Set([...seenKeys, ...currentKeys]);
}

export function evaluateStartupSkillNotification(
  updatable: UpdatableSkillInfo[],
  newSkills: NewSkillInfo[],
  seenKeys: Set<string>,
): {
  shouldShow: boolean;
  currentKeys: string[];
  nextSeenKeys: Set<string>;
} {
  const currentKeys = buildStartupSkillNotificationKeys(updatable, newSkills);
  const shouldShow = hasUnseenStartupSkillNotifications(currentKeys, seenKeys);
  const nextSeenKeys = shouldShow
    ? mergeSeenStartupSkillNotificationKeys(seenKeys, currentKeys)
    : seenKeys;

  return { shouldShow, currentKeys, nextSeenKeys };
}
