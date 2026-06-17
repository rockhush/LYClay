const failedUpdateSlugs = new Set<string>();
const listeners = new Set<() => void>();

function notifyListeners(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function resolveSkillUpdateFailureKeys(
  skill: Pick<{ id?: string | number | null; slug?: string | null }, 'id' | 'slug'> | string,
): string[] {
  if (typeof skill === 'string') {
    const key = skill.trim();
    return key ? [key] : [];
  }

  const keys = new Set<string>();
  const slug = skill.slug?.trim();
  if (slug) keys.add(slug);
  if (skill.id != null) {
    const id = String(skill.id).trim();
    if (id) keys.add(id);
  }
  return Array.from(keys);
}

export function markSkillUpdateFailed(slug: string): void {
  markSkillUpdateFailedForSkill(slug);
}

export function markSkillUpdateFailedForSkill(
  skill: Pick<{ id?: string | number | null; slug?: string | null }, 'id' | 'slug'> | string,
): void {
  let changed = false;
  for (const key of resolveSkillUpdateFailureKeys(skill)) {
    if (failedUpdateSlugs.has(key)) continue;
    failedUpdateSlugs.add(key);
    changed = true;
  }
  if (changed) notifyListeners();
}

export function clearSkillUpdateFailed(slug: string): void {
  clearSkillUpdateFailedForSkill(slug);
}

export function clearSkillUpdateFailedForSkill(
  skill: Pick<{ id?: string | number | null; slug?: string | null }, 'id' | 'slug'> | string,
): void {
  let changed = false;
  for (const key of resolveSkillUpdateFailureKeys(skill)) {
    if (!failedUpdateSlugs.delete(key)) continue;
    changed = true;
  }
  if (changed) notifyListeners();
}

export function isSkillUpdateFailed(slug: string): boolean {
  return isSkillUpdateFailedForSkill(slug);
}

export function isSkillUpdateFailedForSkill(
  skill: Pick<{ id?: string | number | null; slug?: string | null }, 'id' | 'slug'> | string,
): boolean {
  return resolveSkillUpdateFailureKeys(skill).some((key) => failedUpdateSlugs.has(key));
}

export function subscribeSkillUpdateFailures(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test helper */
export function resetSkillUpdateFailuresForTests(): void {
  failedUpdateSlugs.clear();
  notifyListeners();
}
