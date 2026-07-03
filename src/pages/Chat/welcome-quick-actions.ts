import { findSkillByLookupNames } from '@/lib/skill-runtime-aliases';
import type { Skill } from '@/types/skill';

export interface WelcomeQuickActionDefinition {
  key: string;
  labelKey: string;
  skillNames: string[];
  defaultPrompt: string;
}

export const WELCOME_QUICK_ACTIONS: WelcomeQuickActionDefinition[] = [
  {
    key: 'knowledgeQa',
    labelKey: 'welcome.knowledgeQa',
    skillNames: ['领益百事通'],
    defaultPrompt: '请使用这个技能，帮我解答一个领益内部流程相关的问题：',
  },
  {
    key: 'groupSummary',
    labelKey: 'welcome.groupSummary',
    skillNames: ['dws', '办公助手（日程、钉盘、表格、消息）', '办公助手'],
    defaultPrompt: '请使用这个技能，帮我总结以下群消息要点：',
  },
  {
    key: 'pptGeneration',
    labelKey: 'welcome.pptGeneration',
    skillNames: ['PPT生成'],
    defaultPrompt: '请使用这个技能，帮我根据以下内容生成一份PPT：',
  },
  {
    key: 'smartTranslation',
    labelKey: 'welcome.smartTranslation',
    skillNames: ['商务场景翻译助手'],
    defaultPrompt: '请使用这个技能，帮我翻译以下内容：',
  },
];

export function findSkillForQuickAction(
  skills: Skill[],
  skillNames: string[],
): Skill | undefined {
  return findSkillByLookupNames(skills, skillNames);
}

export const SKILL_INVOCATION_HINT = '请使用这个技能，帮我';

export function buildSkillMentionWithHint(skillName: string): string {
  const mentionName = skillName.trim();
  return `@${mentionName} ${SKILL_INVOCATION_HINT}`;
}

export function buildQuickActionComposerText(
  skill: Skill | undefined,
  fallbackSkillName: string,
  defaultPrompt: string,
): string {
  const mentionName = skill?.name?.trim() || fallbackSkillName.trim();
  return `@${mentionName} ${defaultPrompt}`;
}
