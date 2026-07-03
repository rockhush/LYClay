import { describe, expect, it } from 'vitest';
import {
  findSkillByLookupNames,
  resolveBuiltinSkillRuntimeFilterName,
  resolveBuiltinSkillSlugFromAlias,
  rewriteBuiltinSkillMentionsInText,
  rewriteRuntimeSkillMentionsToDisplayInText,
} from '@/lib/skill-runtime-aliases';
import {
  resolveComposerForcedSkillFilter,
  resolveComposerSkillMentionName,
  resolveForcedSkillFilterNames,
} from '@/lib/composer-skill-binding';
import { detectMentionedSkillIds } from '@/stores/chat/usage-report-extract';
import type { Skill } from '@/types/skill';

const dwsSkill: Skill = {
  id: 'dws',
  slug: 'dws',
  name: 'dws',
  description: 'DingTalk workspace',
  enabled: true,
};

const dwsSkillWithDisplayName: Skill = {
  id: 'dws',
  slug: 'dws',
  name: '办公助手（日程、钉盘、表格、消息）',
  description: 'DingTalk workspace',
  enabled: true,
  isBundled: true,
};

describe('skill-runtime-aliases', () => {
  it('maps office assistant display names to the dws slug', () => {
    expect(resolveBuiltinSkillSlugFromAlias('办公助手')).toBe('dws');
    expect(resolveBuiltinSkillSlugFromAlias('办公助手（日程、钉盘、表格、消息）')).toBe('dws');
  });

  it('finds bundled dws via office assistant lookup names', () => {
    expect(findSkillByLookupNames([dwsSkill], ['办公助手'])?.id).toBe('dws');
  });

  it('detects @办公助手 mentions against the dws skill id', () => {
    expect(detectMentionedSkillIds(
      '@办公助手（日程、钉盘、表格、消息） 请使用这个技能，帮我总结群消息',
      [dwsSkill],
    )).toEqual(['dws']);
  });

  it('builds OpenClaw skillFilter with the runtime skill name', () => {
    expect(resolveComposerForcedSkillFilter(
      '@办公助手 请使用这个技能，帮我总结群消息',
      [dwsSkill],
      [],
    )).toEqual(['dws']);
  });

  it('maps slash-picker ids to runtime names when sidecar overwrote the display name', () => {
    expect(resolveForcedSkillFilterNames(['dws'], [dwsSkillWithDisplayName])).toEqual(['dws']);
    expect(resolveComposerForcedSkillFilter(
      '@办公助手（日程、钉盘、表格、消息） 请使用这个技能，帮我总结群消息',
      [dwsSkillWithDisplayName],
      ['dws'],
    )).toEqual(['dws']);
  });

  it('detects @dws mentions even when the store uses a display name', () => {
    expect(detectMentionedSkillIds(
      '@dws 请使用这个技能，帮我总结群消息',
      [dwsSkillWithDisplayName],
    )).toEqual(['dws']);
  });

  it('falls back to runtime filter name when the skills list is not loaded yet', () => {
    expect(resolveForcedSkillFilterNames(['dws'], [])).toEqual(['dws']);
    expect(resolveBuiltinSkillRuntimeFilterName('lingyi-baishitong')).toBe('领益百事通');
  });

  it('rewrites @办公助手 mentions to @dws for gateway messages', () => {
    const text = '@办公助手（日程、钉盘、表格、消息） 请使用这个技能，帮我总结群消息';
    expect(rewriteBuiltinSkillMentionsInText(text, [dwsSkillWithDisplayName])).toBe(
      '@dws 请使用这个技能，帮我总结群消息',
    );
  });

  it('uses display mention name in the composer for bundled skills', () => {
    expect(resolveComposerSkillMentionName(dwsSkillWithDisplayName)).toBe('办公助手（日程、钉盘、表格、消息）');
  });

  it('maps marketplace display names to folder slugs for skillFilter', () => {
    const translatorSkill: Skill = {
      id: 'manufacturing-translator',
      slug: 'manufacturing-translator',
      name: '商务场景翻译助手',
      description: 'Manufacturing translator',
      enabled: true,
    };
    expect(resolveComposerForcedSkillFilter(
      '@商务场景翻译助手 请使用这个技能，帮我翻译',
      [translatorSkill],
      [],
    )).toEqual(['manufacturing-translator']);
    expect(detectMentionedSkillIds(
      '@商务场景翻译助手 请使用这个技能，帮我翻译',
      [translatorSkill],
    )).toEqual(['manufacturing-translator']);
    expect(rewriteBuiltinSkillMentionsInText(
      '@商务场景翻译助手 请使用这个技能，帮我翻译',
      [translatorSkill],
    )).toBe('@manufacturing-translator 请使用这个技能，帮我翻译');
    expect(resolveComposerSkillMentionName(translatorSkill)).toBe('商务场景翻译助手');
    expect(findSkillByLookupNames([], ['商务场景翻译助手'])).toBeUndefined();
    expect(findSkillByLookupNames([translatorSkill], ['商务场景翻译助手'])?.id)
      .toBe('manufacturing-translator');
  });

  it('rewrites runtime @mentions back to display names for chat UI', () => {
    const translatorSkill: Skill = {
      id: 'manufacturing-translator',
      slug: 'manufacturing-translator',
      name: '商务场景翻译助手',
      description: 'Manufacturing translator',
      enabled: true,
    };
    const runtimeText = '@manufacturing-translator 请使用这个技能，帮我翻译';
    expect(rewriteRuntimeSkillMentionsToDisplayInText(runtimeText, [translatorSkill])).toBe(
      '@商务场景翻译助手 请使用这个技能，帮我翻译',
    );
    expect(rewriteRuntimeSkillMentionsToDisplayInText(
      '@dws 请使用这个技能，帮我',
      [dwsSkillWithDisplayName],
    )).toBe('@办公助手（日程、钉盘、表格、消息） 请使用这个技能，帮我');
    expect(rewriteBuiltinSkillMentionsInText(
      '@商务场景翻译助手 请使用这个技能，帮我翻译',
      [translatorSkill],
    )).toBe('@manufacturing-translator 请使用这个技能，帮我翻译');
  });
});
