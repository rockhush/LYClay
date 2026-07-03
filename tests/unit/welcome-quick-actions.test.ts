import { describe, expect, it } from 'vitest';
import type { Skill } from '@/types/skill';
import {
  buildQuickActionComposerText,
  buildSkillMentionWithHint,
  findSkillForQuickAction,
} from '../../src/pages/Chat/welcome-quick-actions';

const mockSkills: Skill[] = [
  {
    id: 'lingyi',
    slug: 'lingyi',
    name: '领益百事通',
    description: '',
    enabled: true,
    icon: '📦',
    version: 'unknown',
    config: {},
    isCore: false,
    isBundled: false,
  },
  {
    id: 'office',
    slug: 'office',
    name: '办公助手（日程、钉盘、表格、消息）',
    description: '',
    enabled: true,
    icon: '📦',
    version: '1.0.0',
    config: {},
    isCore: false,
    isBundled: false,
  },
  {
    id: 'dws',
    slug: 'dws',
    name: 'dws',
    description: '',
    enabled: true,
    icon: '📦',
    version: 'unknown',
    config: {},
    isCore: false,
    isBundled: true,
  },
];

describe('welcome-quick-actions', () => {
  it('finds installed skills by display name', () => {
    expect(findSkillForQuickAction(mockSkills, ['领益百事通'])?.name).toBe('领益百事通');
    expect(findSkillForQuickAction(mockSkills, ['办公助手'])?.name).toBe('办公助手（日程、钉盘、表格、消息）');
  });

  it('finds bundled dws via office assistant quick-action names', () => {
    const skillsWithoutOfficeCard = mockSkills.filter((skill) => skill.id !== 'office');
    expect(findSkillForQuickAction(skillsWithoutOfficeCard, ['办公助手'])?.id).toBe('dws');
  });

  it('builds composer text with @mention and default prompt', () => {
    const skill = findSkillForQuickAction(mockSkills, ['领益百事通']);
    expect(buildQuickActionComposerText(skill, '领益百事通', '请使用这个技能，帮我解答：')).toBe(
      '@领益百事通 请使用这个技能，帮我解答：',
    );
  });

  it('builds composer text with display name for quick-action skills', () => {
    const skill = findSkillForQuickAction(mockSkills, ['办公助手']);
    expect(buildQuickActionComposerText(skill, '办公助手', '请使用这个技能，帮我总结群消息：')).toBe(
      '@办公助手（日程、钉盘、表格、消息） 请使用这个技能，帮我总结群消息：',
    );
  });

  it('builds skill mention with invocation hint for composer pickers', () => {
    expect(buildSkillMentionWithHint('翻译工具')).toBe('@翻译工具 请使用这个技能，帮我');
  });
});
