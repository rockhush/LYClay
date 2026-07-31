import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const root = join(tmpdir(), `lyclaw-de-welcome-skills-${Math.random().toString(36).slice(2)}`);

beforeEach(async () => {
  await rm(root, { recursive: true, force: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('digital employee welcome skills', () => {
  it('reads display names from packaged skill directories', async () => {
    const installPath = join(root, 'dqe-quality-specialist-0206ab31');
    const skillDir = join(installPath, 'skills', 'dqe-sip-create');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), `---
name: SIP制作
description: Create SIP documents.
---
`, 'utf8');

    const { listDigitalEmployeeWelcomeSkills } = await import('@electron/utils/digital-employee-welcome-skills');
    const skills = await listDigitalEmployeeWelcomeSkills({
      installPath,
      packagedSkills: [{ slug: 'dqe-sip-create', required: true }],
    });

    expect(skills).toEqual([{
      slug: 'dqe-sip-create',
      name: 'SIP制作',
      baseDir: skillDir,
    }]);
  });

  it('scans skills directory when packagedSkills is empty', async () => {
    const installPath = join(root, 'recruit-de-1');
    const skillDir = join(installPath, 'skills', 'dqe-yield-analysis');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), `---
name: 良率分析
description: Analyze yield.
---
`, 'utf8');

    const { listDigitalEmployeeWelcomeSkills } = await import('@electron/utils/digital-employee-welcome-skills');
    const skills = await listDigitalEmployeeWelcomeSkills({
      installPath,
      packagedSkills: [],
    });

    expect(skills.map((skill) => skill.slug)).toEqual(['dqe-yield-analysis']);
    expect(skills[0]?.name).toBe('良率分析');
  });
});
