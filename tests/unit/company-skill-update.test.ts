import { describe, expect, it } from 'vitest';
import { resolveSkillHasUpdate, unwrapCompanyCheckUpdatePayload } from '@electron/utils/company-skill-update';

describe('unwrapCompanyCheckUpdatePayload', () => {
  it('unwraps nested company API envelope', () => {
    expect(unwrapCompanyCheckUpdatePayload({
      success: true,
      data: {
        has_update: true,
        latest_version: '1.0.2',
        skill_name: '考勤查询',
        skill_id: 71,
      },
      message: '最新版本 1.0.2',
    })).toEqual({
      has_update: true,
      latest_version: '1.0.2',
      skill_name: '考勤查询',
      skill_id: 71,
    });
  });

  it('accepts flat payload for backward compatibility', () => {
    expect(unwrapCompanyCheckUpdatePayload({
      has_update: false,
      latest_version: '',
      skill_name: '考勤查询',
      skill_id: 71,
    })).toEqual({
      has_update: false,
      latest_version: '',
      skill_name: '考勤查询',
      skill_id: 71,
    });
  });
});

describe('resolveSkillHasUpdate', () => {
  it('marks updatable when current and latest differ', () => {
    expect(resolveSkillHasUpdate('2.0', '1.0.2')).toBe(true);
  });

  it('marks not updatable when current and latest match', () => {
    expect(resolveSkillHasUpdate('2.0', '2.0')).toBe(false);
    expect(resolveSkillHasUpdate('1.0.2', '1.0.2')).toBe(false);
  });

  it('marks not updatable when latest is missing', () => {
    expect(resolveSkillHasUpdate('2.0', undefined)).toBe(false);
    expect(resolveSkillHasUpdate('2.0', '')).toBe(false);
  });
});
