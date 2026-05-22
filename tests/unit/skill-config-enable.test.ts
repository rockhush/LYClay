import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testHome = join(process.cwd(), 'temp_skill_config_enable_home');

vi.mock('os', () => ({
  homedir: () => testHome,
  default: {
    homedir: () => testHome,
  },
}));

async function writeOpenClawJson(config: Record<string, unknown>): Promise<void> {
  const dir = join(testHome, '.openclaw');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'openclaw.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

describe('skill enable config', () => {
  beforeEach(async () => {
    vi.resetModules();
    await rm(testHome, { recursive: true, force: true });
  });

  afterEach(async () => {
    await rm(testHome, { recursive: true, force: true });
  });

  it('resolves config keys across slug/name variants', async () => {
    await writeOpenClawJson({
      skills: {
        entries: {
          'Data-Analysis': { enabled: false },
        },
      },
    });

    const { resolveSkillConfigKey } = await import('@electron/utils/skill-config');
    await expect(resolveSkillConfigKey(['data-analysis'])).resolves.toBe('Data-Analysis');
    await expect(resolveSkillConfigKey(['Data Analysis'])).resolves.toBe('Data-Analysis');
  });

  it('writes enabled state directly to openclaw.json', async () => {
    await writeOpenClawJson({
      skills: {
        entries: {
          'Data-Analysis': { enabled: false },
        },
      },
    });

    const { setSkillEnabled } = await import('@electron/utils/skill-config');
    const result = await setSkillEnabled('data-analysis', true, { name: 'Data Analysis' });

    expect(result.success).toBe(true);
    expect(result.skillKey).toBe('Data-Analysis');

    const saved = JSON.parse(await readFile(join(testHome, '.openclaw', 'openclaw.json'), 'utf8')) as {
      skills?: { entries?: Record<string, { enabled?: boolean }> };
    };
    expect(saved.skills?.entries?.['Data-Analysis']?.enabled).toBe(true);
  });
});
