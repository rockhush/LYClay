import { describe, expect, it } from 'vitest';
import {
  DEFAULT_USER_CREATED_SKILL_VERSION,
  resolveSkillAuthorDisplayName,
  upsertSkillManifestFrontmatter,
} from '../../electron/utils/user-created-skill-metadata';

describe('user-created-skill-metadata', () => {
  it('resolves full Chinese author names and strips English prefixes', () => {
    expect(resolveSkillAuthorDisplayName('Ken/袁益千')).toBe('袁益千');
    expect(resolveSkillAuthorDisplayName('张三')).toBe('张三');
    expect(resolveSkillAuthorDisplayName('李子豪')).toBe('李子豪');
  });

  it('upserts version and author into existing frontmatter', () => {
    const raw = `---
name: demo-skill
description: test
---
# Demo`;

    const next = upsertSkillManifestFrontmatter(raw, {
      version: DEFAULT_USER_CREATED_SKILL_VERSION,
      author: '袁益千',
    });

    expect(next).toContain(`version: ${DEFAULT_USER_CREATED_SKILL_VERSION}`);
    expect(next).toContain('author: 袁益千');
    expect(next).toContain('name: demo-skill');
  });

  it('creates frontmatter when missing', () => {
    const raw = '# Demo\n\nBody';
    const next = upsertSkillManifestFrontmatter(raw, {
      version: DEFAULT_USER_CREATED_SKILL_VERSION,
      author: '张三',
    });

    expect(next.startsWith('---\n')).toBe(true);
    expect(next).toContain('author: 张三');
  });
});
