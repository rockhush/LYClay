import { findSkillByLookupNames } from '@/lib/skill-runtime-aliases';
import { isDigitalEmployeeSkill, shouldIncludeInMySkills } from '@/lib/skill-metadata';
import type { DigitalEmployeeWelcomeSkill } from '@/types/digital-employee';
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

/** Default prompt suffix when a digital-employee welcome skill chip is clicked. */
export const DIGITAL_EMPLOYEE_WELCOME_SKILL_PROMPT = '请使用这个技能，帮我';

export interface DigitalEmployeeWelcomeSkillItem {
  id: string;
  name: string;
}

function normalizeSkillPathKey(path: string | undefined): string {
  return (path || '').replace(/\\/g, '/').toLowerCase();
}

/** Skills packaged under a digital employee install directory (Gateway skills.status + baseDir). */
export function filterSkillsForDigitalEmployeeInstall(
  skills: Skill[],
  employee: { instanceId: string; installPath?: string },
): Skill[] {
  const instanceId = employee.instanceId.trim().toLowerCase();
  if (!instanceId) return [];

  const installPathKey = normalizeSkillPathKey(employee.installPath);
  const instanceMarkers = [
    `/digital-employees/${instanceId}/`,
    `/lyclaw/digital-employees/${instanceId}/`,
  ];
  if (installPathKey) {
    instanceMarkers.push(`${installPathKey}/`);
  }

  return skills
    .filter((skill) => {
      if (!skill.enabled || !shouldIncludeInMySkills(skill)) return false;
      if (!isDigitalEmployeeSkill(skill)) return false;
      const baseDir = normalizeSkillPathKey(skill.baseDir || skill.filePath);
      if (!baseDir) return false;
      return instanceMarkers.some((marker) => baseDir.includes(marker));
    })
    .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
}

/** Prefer install-dir welcomeSkills; fall back to global Gateway skills when present. */
export function resolveDigitalEmployeeWelcomeSkillItems(
  employee: {
    instanceId: string;
    installPath?: string;
    welcomeSkills?: DigitalEmployeeWelcomeSkill[];
  },
  globalSkills: Skill[],
): DigitalEmployeeWelcomeSkillItem[] {
  if (employee.welcomeSkills?.length) {
    return employee.welcomeSkills.map((skill) => ({
      id: skill.slug,
      name: skill.name,
    }));
  }
  return filterSkillsForDigitalEmployeeInstall(globalSkills, employee).map((skill) => ({
    id: skill.id,
    name: skill.name,
  }));
}

export function buildDigitalEmployeeWelcomeComposerTextFromName(skillName: string): string {
  return buildQuickActionComposerText(undefined, skillName, DIGITAL_EMPLOYEE_WELCOME_SKILL_PROMPT);
}

export function buildDigitalEmployeeWelcomeComposerText(skill: Skill): string {
  return buildQuickActionComposerText(skill, skill.name, DIGITAL_EMPLOYEE_WELCOME_SKILL_PROMPT);
}
