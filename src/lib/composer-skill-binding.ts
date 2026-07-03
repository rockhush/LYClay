import type { Skill } from '@/types/skill';
import { resolveOpenClawSkillFilterName } from '@/lib/skill-runtime-aliases';
import { detectMentionedSkillIds } from '@/stores/chat/usage-report-extract';
import { SKILL_INVOCATION_HINT } from '@/pages/Chat/welcome-quick-actions';

/** UI @mention token shown in the composer (marketplace / sidecar display name). */
export function resolveComposerSkillMentionName(
  skill: Pick<Skill, 'id' | 'slug' | 'name'>,
): string {
  return skill.name?.trim() || skill.slug?.trim() || skill.id.trim();
}

/** OpenClaw runtime skill allowlist uses skill display names, not config keys. */
export function resolveForcedSkillFilterNames(
  skillIds: readonly string[],
  skills: readonly Skill[],
): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const rawId of skillIds) {
    const id = (rawId || '').trim();
    if (!id) continue;
    const skill = skills.find((candidate) => candidate.id === id || candidate.slug === id);
    const name = resolveOpenClawSkillFilterName(id, skill);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/**
 * Build a one-turn skill allowlist for chat.send when the user explicitly picked
 * a skill in the composer (slash/puzzle picker) or used the standard @mention
 * invocation hint.
 */
export function resolveComposerForcedSkillFilter(
  text: string,
  skills: readonly Skill[],
  explicitSkillIds: readonly string[] = [],
): string[] | undefined {
  const ids = new Set<string>();
  for (const id of explicitSkillIds) {
    const trimmed = (id || '').trim();
    if (trimmed) ids.add(trimmed);
  }

  if (text.includes(SKILL_INVOCATION_HINT)) {
    for (const id of detectMentionedSkillIds(text, skills)) {
      ids.add(id);
    }
  }

  if (ids.size === 0) return undefined;
  const names = resolveForcedSkillFilterNames([...ids], skills);
  return names.length > 0 ? names : undefined;
}
