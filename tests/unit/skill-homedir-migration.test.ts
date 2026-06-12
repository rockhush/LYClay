import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testHome = join(process.cwd(), 'temp_skill_homedir_migration_home');

vi.mock('os', () => ({
  homedir: () => testHome,
  default: { homedir: () => testHome },
}));

vi.mock('@electron/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function skillsRoot(): string {
  return join(testHome, '.openclaw', 'skills');
}

function writeSkill(slug: string, extras: Record<string, string> = {}): string {
  const dir = join(skillsRoot(), slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `# ${slug}\n`);
  for (const [name, content] of Object.entries(extras)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

describe('migrateHomedirBuiltinSkills', () => {
  beforeEach(() => {
    vi.resetModules();
    rmSync(testHome, { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(testHome, { recursive: true, force: true });
  });

  it('removes bundled slugs without marketplace sidecar', async () => {
    writeSkill('pdf');
    writeSkill('summarize');
    const { migrateHomedirBuiltinSkills } = await import('@electron/utils/skill-homedir-migration');
    const res = migrateHomedirBuiltinSkills();
    expect(res.removed.sort()).toEqual(['pdf', 'summarize']);
    expect(res.kept).toEqual([]);
  });

  it('keeps company marketplace installs', async () => {
    writeSkill('custom-corp', {
      '.lyclaw-marketplace.json': JSON.stringify({ marketplaceId: 42, packageSlug: 'custom-corp' }),
    });
    writeSkill('pdf');
    const { migrateHomedirBuiltinSkills } = await import('@electron/utils/skill-homedir-migration');
    const res = migrateHomedirBuiltinSkills();
    expect(res.removed).toEqual(['pdf']);
    expect(res.kept).toEqual(['custom-corp']);
  });

  it('removes copies with LYClaw preinstalled marker', async () => {
    writeSkill('pdf', {
      '.LYClaw-preinstalled.json': JSON.stringify({
        source: 'LYClaw-preinstalled',
        slug: 'pdf',
        version: 'main',
        installedAt: '2020-01-01T00:00:00.000Z',
      }),
    });
    const { migrateHomedirBuiltinSkills } = await import('@electron/utils/skill-homedir-migration');
    const res = migrateHomedirBuiltinSkills();
    expect(res.removed).toEqual(['pdf']);
  });

  it('keeps unknown user skills not in bundled list', async () => {
    writeSkill('my-private-skill');
    const { migrateHomedirBuiltinSkills } = await import('@electron/utils/skill-homedir-migration');
    const res = migrateHomedirBuiltinSkills();
    expect(res.removed).toEqual([]);
    expect(res.kept).toEqual(['my-private-skill']);
  });

  it('is idempotent on second run', async () => {
    writeSkill('dws');
    const { migrateHomedirBuiltinSkills } = await import('@electron/utils/skill-homedir-migration');
    const first = migrateHomedirBuiltinSkills();
    expect(first.removed).toEqual(['dws']);
    const second = migrateHomedirBuiltinSkills();
    expect(second.removed).toEqual([]);
    expect(second.examined).toBe(0);
  });
});
