/** Parse company marketplace timestamps such as "2026-06-11 10:14:10". */
export function parseMarketplaceTimestamp(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) return 0;

  const normalized = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T');
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

export const NEW_SKILL_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

/** Whether a skill's create_time falls within the last `windowMs` (default 3 days). */
export function isNewSkillByCreateTime(
  createTime: string | undefined,
  now = Date.now(),
  windowMs = NEW_SKILL_WINDOW_MS,
): boolean {
  if (!createTime?.trim()) return false;

  const createdAt = parseMarketplaceTimestamp(createTime);
  if (createdAt <= 0) return false;

  return createdAt <= now && now - createdAt <= windowMs;
}
