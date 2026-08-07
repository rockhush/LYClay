import { describe, expect, it } from 'vitest';
import {
  applySkillOrder,
  mergeSkillOrder,
  removeSkillIdFromOrder,
  reorderSkillIds,
} from '../../src/lib/skill-order';
import type { Skill } from '../../src/types/skill';

function createSkill(id: string, name: string): Skill {
  return {
    id,
    name,
    description: '',
    enabled: true,
  };
}

describe('skill order helpers', () => {
  const skills = [
    createSkill('skill-a', 'Alpha'),
    createSkill('skill-b', 'Beta'),
    createSkill('skill-c', 'Gamma'),
  ];

  it('applies saved order and appends unknown skills', () => {
    expect(applySkillOrder(skills, ['skill-c', 'skill-a']).map((skill) => skill.id)).toEqual([
      'skill-c',
      'skill-a',
      'skill-b',
    ]);
  });

  it('merges new skills to the end without disturbing existing order', () => {
    expect(mergeSkillOrder(['skill-b', 'skill-a'], skills)).toEqual(['skill-b', 'skill-a', 'skill-c']);
  });

  it('swaps two ids in place without shifting others', () => {
    expect(reorderSkillIds(['skill-a', 'skill-b', 'skill-c'], 'skill-c', 'skill-a')).toEqual([
      'skill-c',
      'skill-b',
      'skill-a',
    ]);
  });

  it('removes deleted skill ids from saved order', () => {
    expect(removeSkillIdFromOrder(['skill-a', 'skill-b', 'skill-c'], 'skill-b')).toEqual([
      'skill-a',
      'skill-c',
    ]);
  });
});
