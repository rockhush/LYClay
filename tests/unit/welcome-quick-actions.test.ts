import { describe, expect, it } from 'vitest';
import type { Skill } from '@/types/skill';
import {
  buildDigitalEmployeeWelcomeComposerText,
  buildDigitalEmployeeWelcomeComposerTextFromName,
  buildQuickActionComposerText,
  buildSkillMentionWithHint,
  filterSkillsForDigitalEmployeeInstall,
  findSkillForQuickAction,
  resolveDigitalEmployeeWelcomeSkillItems,
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

  it('filters skills under a digital employee install directory', () => {
    const skills: Skill[] = [
      ...mockSkills,
      {
        id: 'de-sip',
        slug: 'dqe-sip-create',
        name: 'SIP制作',
        description: '',
        enabled: true,
        source: 'digital_employee',
        baseDir: 'C:\\Users\\me\\.openclaw\\digital-employees\\recruit-de-1\\skills\\dqe-sip-create',
      },
      {
        id: 'global-ppt',
        slug: 'pptx',
        name: 'PPT生成',
        description: '',
        enabled: true,
        baseDir: 'C:\\Users\\me\\.openclaw\\skills\\pptx',
      },
    ];

    const filtered = filterSkillsForDigitalEmployeeInstall(skills, {
      instanceId: 'recruit-de-1',
      installPath: 'C:\\Users\\me\\.openclaw\\digital-employees\\recruit-de-1',
    });

    expect(filtered.map((skill) => skill.id)).toEqual(['de-sip']);
  });

  it('builds digital employee welcome composer text', () => {
    expect(buildDigitalEmployeeWelcomeComposerText({
      id: 'de-sip',
      slug: 'dqe-sip-create',
      name: 'SIP制作',
      description: '',
      enabled: true,
    })).toBe('@SIP制作 请使用这个技能，帮我');
  });

  it('builds digital employee welcome composer text from display name', () => {
    expect(buildDigitalEmployeeWelcomeComposerTextFromName('SIP制作')).toBe('@SIP制作 请使用这个技能，帮我');
  });

  it('prefers install-dir welcomeSkills over global skills filter', () => {
    const items = resolveDigitalEmployeeWelcomeSkillItems(
      {
        instanceId: 'dqe-quality-specialist-0206ab31',
        installPath: 'C:\\Users\\me\\.openclaw\\digital-employees\\dqe-quality-specialist-0206ab31',
        welcomeSkills: [
          {
            slug: 'dqe-sip-create',
            name: 'SIP制作',
            baseDir: 'C:\\Users\\me\\.openclaw\\digital-employees\\dqe-quality-specialist-0206ab31\\skills\\dqe-sip-create',
          },
          {
            slug: 'dqe-cpk-report',
            name: 'CPK报告',
            baseDir: 'C:\\Users\\me\\.openclaw\\digital-employees\\dqe-quality-specialist-0206ab31\\skills\\dqe-cpk-report',
          },
        ],
      },
      [],
    );

    expect(items).toEqual([
      { id: 'dqe-sip-create', name: 'SIP制作' },
      { id: 'dqe-cpk-report', name: 'CPK报告' },
    ]);
  });
});
