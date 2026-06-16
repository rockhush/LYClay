const failedUpdateSlugs = new Set<string>();
const listeners = new Set<() => void>();

function notifyListeners(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function markSkillUpdateFailed(slug: string): void {
  const key = slug.trim();
  if (!key) return;
  if (failedUpdateSlugs.has(key)) return;
  failedUpdateSlugs.add(key);
  notifyListeners();
}

export function clearSkillUpdateFailed(slug: string): void {
  const key = slug.trim();
  if (!key) return;
  if (!failedUpdateSlugs.delete(key)) return;
  notifyListeners();
}

export function isSkillUpdateFailed(slug: string): boolean {
  return failedUpdateSlugs.has(slug.trim());
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
