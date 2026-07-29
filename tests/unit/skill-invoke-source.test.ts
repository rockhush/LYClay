import { describe, expect, it } from 'vitest';
import {
  isDigitalEmployeeSkillPath,
  normalizeSkillInvokeReportSource,
} from '../../shared/reporting/skill-invoke-source';

describe('isDigitalEmployeeSkillPath', () => {
  it('detects digital employee bundled skill paths', () => {
    expect(isDigitalEmployeeSkillPath(
      '~/.openclaw/digital-employees/dqe-quality-specialist-0206ab31/skills/dqe-sip-create/SKILL.md',
    )).toBe(true);
    expect(isDigitalEmployeeSkillPath(
      'C:\\Users\\me\\.openclaw\\digital-employees\\pkg-1\\skills\\foo\\SKILL.md',
    )).toBe(true);
  });

  it('returns false for workspace and global skill paths', () => {
    expect(isDigitalEmployeeSkillPath('~/.openclaw/skills/pptx/SKILL.md')).toBe(false);
    expect(isDigitalEmployeeSkillPath('')).toBe(false);
  });
});

describe('normalizeSkillInvokeReportSource', () => {
  it('maps digital employee baseDir hints', () => {
    expect(normalizeSkillInvokeReportSource(undefined, {
      baseDir: '~/.openclaw/digital-employees/pkg/skills/foo',
    })).toBe('digital_employee');
  });
});
