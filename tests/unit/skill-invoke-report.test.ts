import { describe, expect, it } from 'vitest';
import { resolveSkillSource } from '@/lib/skill-invoke-report';

describe('resolveSkillSource', () => {
  it('prefers digital_employee when SKILL.md path is under digital-employees', () => {
    const source = resolveSkillSource('dqe-sip-create', [
      { id: 'dqe-sip-create', slug: 'dqe-sip-create', source: 'local' },
    ], {
      skillPath: '~/.openclaw/digital-employees/dqe-quality-specialist-0206ab31/skills/dqe-sip-create/SKILL.md',
    });
    expect(source).toBe('digital_employee');
  });

  it('keeps local for global skills without digital employee path hint', () => {
    const source = resolveSkillSource('pptx', [
      { id: 'pptx', slug: 'pptx', source: 'local' },
    ], {
      skillPath: '~/.openclaw/skills/pptx/SKILL.md',
    });
    expect(source).toBe('local');
  });
});
