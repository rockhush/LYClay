import { LYCLAW_BUILTIN_SKILL_KEYS, normalizeSkillLookupKey } from '@/lib/skill-metadata';
import type { Skill } from '@/types/skill';

/** UI / marketplace display aliases → bundled skill slug (OpenClaw skills dir name). */
const BUILTIN_SKILL_ALIAS_TO_SLUG_ENTRIES: ReadonlyArray<[string, string]> = [
  ['办公助手（日程、钉盘、表格、消息）', 'dws'],
  ['办公助手', 'dws'],
  ['钉钉办公助手', 'dws'],
];

/** OpenClaw `skillFilter` uses SKILL.md `name` when it differs from slug. */
const BUILTIN_SKILL_RUNTIME_NAME_BY_SLUG: Readonly<Record<string, string>> = {
  dws: 'dws',
  'lingyi-baishitong': '领益百事通',
};

const builtinAliasToSlug = new Map<string, string>(
  BUILTIN_SKILL_ALIAS_TO_SLUG_ENTRIES.map(([alias, slug]) => [
    normalizeSkillLookupKey(alias),
    slug,
  ]),
);

/** Longest alias first so `@办公助手（日程、钉盘、表格、消息）` wins over `@办公助手`. */
export const BUILTIN_SKILL_MENTION_ALIASES: ReadonlyArray<{ alias: string; skillSlug: string }> = [
  ...BUILTIN_SKILL_ALIAS_TO_SLUG_ENTRIES.map(([alias, skillSlug]) => ({ alias, skillSlug })),
].sort((a, b) => b.alias.length - a.alias.length);

export function resolveBuiltinSkillSlugFromAlias(value: string | undefined): string | undefined {
  const key = normalizeSkillLookupKey(value);
  if (!key) return undefined;
  return builtinAliasToSlug.get(key);
}

/** Runtime skill name for OpenClaw skillFilter (SKILL.md `name` field). */
export function resolveBuiltinSkillRuntimeFilterName(skillKey: string | undefined): string | undefined {
  const trimmed = (skillKey || '').trim();
  if (!trimmed) return undefined;

  const slug = resolveBuiltinSkillSlugFromAlias(trimmed) || trimmed;
  const explicit = BUILTIN_SKILL_RUNTIME_NAME_BY_SLUG[slug];
  if (explicit) return explicit;
  if (LYCLAW_BUILTIN_SKILL_KEYS.has(slug)) return slug;
  return undefined;
}

/** Map a composer skill id to the name OpenClaw expects in skillFilter. */
export function resolveOpenClawSkillFilterName(
  skillId: string,
  skill?: Pick<Skill, 'id' | 'slug' | 'name'>,
): string | undefined {
  const trimmedId = skillId.trim();
  if (!trimmedId) return undefined;

  const lookupKeys = [...new Set(
    [skill?.id, skill?.slug, trimmedId]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value)),
  )];

  for (const key of lookupKeys) {
    const runtimeName = resolveBuiltinSkillRuntimeFilterName(key);
    if (runtimeName) return runtimeName;
  }

  return skill?.name?.trim() || undefined;
}

export function findSkillBySlug(skills: readonly Skill[], slug: string): Skill | undefined {
  const normalized = normalizeSkillLookupKey(slug);
  if (!normalized) return undefined;
  return skills.find((skill) =>
    [skill.id, skill.slug, skill.name].some(
      (value) => normalizeSkillLookupKey(value) === normalized,
    ),
  );
}

/** Resolve quick-action / lookup names, including bundled display aliases. */
function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace @display aliases with OpenClaw runtime skill names in outbound chat text
 * so the model resolves `~/.openclaw/skills/<slug>/SKILL.md` correctly.
 */
export function rewriteBuiltinSkillMentionsInText(
  text: string,
  skills: readonly Skill[] = [],
): string {
  if (!text) return text;
  let next = text;

  for (const { alias, skillSlug } of BUILTIN_SKILL_MENTION_ALIASES) {
    const runtimeName = resolveBuiltinSkillRuntimeFilterName(skillSlug);
    if (!runtimeName || normalizeSkillLookupKey(alias) === normalizeSkillLookupKey(runtimeName)) {
      continue;
    }
    const pattern = new RegExp(`@${escapeRegexLiteral(alias)}(?![\\w-])`, 'gi');
    next = next.replace(pattern, `@${runtimeName}`);
  }

  for (const skill of skills) {
    const displayName = skill.name?.trim();
    if (!displayName) continue;
    const runtimeName = resolveOpenClawSkillFilterName(skill.id, skill);
    if (!runtimeName || normalizeSkillLookupKey(displayName) === normalizeSkillLookupKey(runtimeName)) {
      continue;
    }
    const pattern = new RegExp(`@${escapeRegexLiteral(displayName)}(?![\\w-])`, 'gi');
    next = next.replace(pattern, `@${runtimeName}`);
  }

  return next;
}

export function findSkillByLookupNames(
  skills: readonly Skill[],
  lookupNames: readonly string[],
): Skill | undefined {
  for (const candidate of lookupNames) {
    const target = normalizeSkillLookupKey(candidate);
    if (!target) continue;

    const exact = skills.find((skill) =>
      [skill.name, skill.slug, skill.id].some(
        (value) => normalizeSkillLookupKey(value) === target,
      ),
    );
    if (exact) return exact;
  }

  for (const candidate of lookupNames) {
    const target = normalizeSkillLookupKey(candidate);
    if (!target) continue;

    const partial = skills.find((skill) => {
      const name = normalizeSkillLookupKey(skill.name);
      return name.includes(target) || target.includes(name);
    });
    if (partial) return partial;
  }

  for (const candidate of lookupNames) {
    const slug = resolveBuiltinSkillSlugFromAlias(candidate);
    if (!slug) continue;
    const skill = findSkillBySlug(skills, slug);
    if (skill) return skill;
  }

  return undefined;
}
