import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const skillDir = join(root, 'resources', 'builtin-skills', 'mineru-ocr');
const deprecatedBackends = [
  'hybrid-auto-engine',
  'vlm-auto-engine',
  'vlm-vllm-engine',
  'vlm-vllm-async-engine',
  'vlm-lmdeploy-engine',
];

function readSkillFile(relativePath: string): string {
  return readFileSync(join(skillDir, relativePath), 'utf8');
}

describe('mineru-ocr bundled skill', () => {
  it('uses the current MinerU vlm-engine backend everywhere', () => {
    const script = readSkillFile('scripts/mineru_ocr.py');
    const apiSchema = readSkillFile('references/api_schema.md');
    const skillManifest = readSkillFile('SKILL.md');

    expect(script).toContain('"backend": "vlm-engine"');
    expect(apiSchema).toContain('`vlm-engine`');
    expect(skillManifest).toContain('version: 1.0.1');

    for (const backend of deprecatedBackends) {
      expect(script).not.toContain(backend);
      expect(apiSchema).not.toContain(backend);
      expect(skillManifest).not.toContain(backend);
    }
  });
});
