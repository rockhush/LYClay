import { beforeAll, describe, expect, it } from 'vitest';
import i18n from 'i18next';
import zhSkills from '@/i18n/locales/zh/skills.json';
import enSkills from '@/i18n/locales/en/skills.json';
import { resolveSkillFolderOpenError } from '@/pages/Skills/folder-error-presentation';

beforeAll(async () => {
  await i18n.init({
    lng: 'zh',
    fallbackLng: 'en',
    resources: {
      zh: { skills: zhSkills },
      en: { skills: enSkills },
    },
  });
});

describe('resolveSkillFolderOpenError', () => {
  it('maps unauthorized workspace paths to actionable guidance', () => {
    const message = resolveSkillFolderOpenError(
      new Error('Path is outside authorized workspaces or session grants'),
      i18n.getFixedT('zh', 'skills'),
    );

    expect(message).toContain('安全策略未授权');
    expect(message).toContain('已授权工作区');
    expect(message).not.toContain('session grants');
  });
});
