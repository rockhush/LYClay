import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const tempRoot = join(process.cwd(), 'temp_merge_bundled_skills');
const scriptPath = join(process.cwd(), 'scripts', 'merge-bundled-skills.mjs');

function readTempSkill(relativePath: string): string {
  return readFileSync(join(tempRoot, 'skills', 'mineru-ocr', relativePath), 'utf8');
}

describe('merge-bundled-skills script', () => {
  beforeEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
    const oldSkillDir = join(tempRoot, 'skills', 'mineru-ocr', 'scripts');
    mkdirSync(oldSkillDir, { recursive: true });
    writeFileSync(join(tempRoot, 'skills', 'mineru-ocr', 'SKILL.md'), '---\nversion: 1.0.0\n---\n', 'utf8');
    writeFileSync(
      join(oldSkillDir, 'mineru_ocr.py'),
      'data = {"backend": "vlm-vllm-async-engine"}\n',
      'utf8',
    );
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('overwrites existing LYClaw builtin skills in the OpenClaw bundle', () => {
    execFileSync(process.execPath, [scriptPath, `--openclaw-dir=${tempRoot}`], {
      cwd: process.cwd(),
      stdio: 'pipe',
    });

    expect(readTempSkill('SKILL.md')).toContain('version: 1.0.1');
    expect(readTempSkill('scripts/mineru_ocr.py')).toContain('"backend": "vlm-engine"');
  });
});
