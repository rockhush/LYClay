import { describe, expect, it } from 'vitest';
import {
  resolveComposerForcedSkillFilter,
  resolveForcedSkillFilterNames,
} from '@/lib/composer-skill-binding';
import type { Skill } from '@/types/skill';

const skills: Skill[] = [
  {
    id: 'ppt-generate',
    name: 'PPT生成',
    description: 'Generate PPT',
    enabled: true,
  },
  {
    id: 'ppt-maker',
    name: 'ppt 制作',
    description: 'Make PPT',
    enabled: true,
  },
];

describe('composer skill binding', () => {
  it('maps explicit skill ids to display names for OpenClaw skillFilter', () => {
    expect(resolveForcedSkillFilterNames(['ppt-generate'], skills)).toEqual(['PPT生成']);
  });

  it('returns undefined when no explicit composer skill selection exists', () => {
    expect(resolveComposerForcedSkillFilter('hello', skills, [])).toBeUndefined();
  });

  it('binds slash/puzzle picker selections via explicit ids', () => {
    expect(resolveComposerForcedSkillFilter('make slides', skills, ['ppt-generate']))
      .toEqual(['PPT生成']);
  });

  it('binds @mention + invocation hint text without picker state', () => {
    expect(resolveComposerForcedSkillFilter(
      '@PPT生成 请使用这个技能，帮我 写一份汇报',
      skills,
      [],
    )).toEqual(['PPT生成']);
  });

  it('does not bind a bare @mention without the invocation hint', () => {
    expect(resolveComposerForcedSkillFilter('@PPT生成 写一份汇报', skills, [])).toBeUndefined();
  });

  it('dedupes explicit ids and @mention matches', () => {
    expect(resolveComposerForcedSkillFilter(
      '@PPT生成 请使用这个技能，帮我',
      skills,
      ['ppt-generate'],
    )).toEqual(['PPT生成']);
  });
});
