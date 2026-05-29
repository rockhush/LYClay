import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  parseSkillManifestFields,
  parseZipBasenameFromContentDisposition,
  resolveLocalUploadSkillMetadata,
  resolvePackageDirName,
  resolvePackageDirNameFromManifest,
} from '../../electron/utils/company-skill-package';

describe('company-skill-package', () => {
  it('prefers manifest slug over display name', () => {
    const manifest = parseSkillManifestFields(`---
slug: dws
name: 候选人简历画像匹配分析
description: test
---`);
    expect(resolvePackageDirNameFromManifest(manifest)).toBe('dws');
  });

  it('falls back to manifest name when slug is absent', () => {
    const manifest = parseSkillManifestFields(`---
name: dws
description: test
---`);
    expect(resolvePackageDirNameFromManifest(manifest)).toBe('dws');
  });

  it('parses quoted manifest scalars with escaped quotes', () => {
    const manifest = parseSkillManifestFields(`---
name: xlsx
description: "Use when the user says \\"the xlsx in my downloads\\" and wants spreadsheet work."
version: "1.0.0"
---`);

    expect(manifest).toMatchObject({
      name: 'xlsx',
      description: 'Use when the user says "the xlsx in my downloads" and wants spreadsheet work.',
      version: '1.0.0',
    });
  });

  it('parses single-quoted manifest scalars', () => {
    const manifest = parseSkillManifestFields(`---
name: xlsx
description: 'Use for .xlsx, .xlsm, .csv, and .tsv files.'
---`);

    expect(manifest.description).toBe('Use for .xlsx, .xlsm, .csv, and .tsv files.');
  });

  it('parses zip filename from content-disposition', () => {
    expect(parseZipBasenameFromContentDisposition('attachment; filename="dws.zip"')).toBe('dws.zip');
    expect(parseZipBasenameFromContentDisposition("attachment; filename*=UTF-8''dws.zip")).toBe('dws.zip');
  });

  it('resolves local upload metadata from manifest with directory fallback', () => {
    const manifest = parseSkillManifestFields(`---
name: 智能助手
version: 1.2.3
---`);
    expect(resolveLocalUploadSkillMetadata(manifest, 'test')).toEqual({
      name: '智能助手',
      version: '1.2.3',
    });

    const manifestWithoutName = parseSkillManifestFields(`---
description: test
---`);
    expect(resolveLocalUploadSkillMetadata(manifestWithoutName, 'test')).toEqual({
      name: 'test',
      version: 'unknown',
    });
  });

  it('resolves package dir from nested archive layout', async () => {
    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lyclaw-skill-test-'));
    const packageDir = path.join(tempRoot, 'dws');
    await fs.promises.mkdir(packageDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(packageDir, 'SKILL.md'),
      `---
name: dws
description: test
---`,
      'utf8',
    );

    await expect(resolvePackageDirName(tempRoot, '候选人简历画像匹配分析.zip')).resolves.toBe('dws');
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });
});
