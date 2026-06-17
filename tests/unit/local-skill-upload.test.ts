import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  extractZipToDir,
  installLocalSkillFromExtractedContent,
  resolveLocalUploadPackageDirName,
} from '../../electron/utils/local-skill-upload';
import { resolveDigitalEmployeePackageRoot } from '../../electron/utils/digital-employee-package';

describe('local-skill-upload', () => {
  it('uses zip basename as package directory name', () => {
    expect(resolveLocalUploadPackageDirName('test.zip')).toBe('test');
    expect(resolveLocalUploadPackageDirName('My Skill.ZIP')).toBe('My Skill');
  });

  it('installs flat archive contents into skills/<zip-name>/', async () => {
    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lyclaw-upload-test-'));
    const skillsDir = path.join(tempRoot, 'skills');
    const extractDir = path.join(tempRoot, 'extract');
    await fs.promises.mkdir(extractDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(extractDir, 'SKILL.md'),
      `---
name: yaml-name
version: 2.0.0
description: test
---`,
      'utf8',
    );
    await fs.promises.writeFile(path.join(extractDir, 'helper.txt'), 'hello', 'utf8');

    const result = await installLocalSkillFromExtractedContent({
      extractDir,
      fileName: 'test.zip',
      skillsDir,
    });

    expect(result.skillName).toBe('yaml-name');
    expect(result.skillVersion).toBe('2.0.0');
    expect(result.skillDir).toBe(path.join(skillsDir, 'test'));
    expect(fs.existsSync(path.join(result.skillDir, 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(result.skillDir, 'helper.txt'))).toBe(true);
    expect(fs.existsSync(path.join(skillsDir, 'SKILL.md'))).toBe(false);

    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });

  it('installs nested archive contents into skills/<zip-name>/', async () => {
    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lyclaw-upload-test-'));
    const skillsDir = path.join(tempRoot, 'skills');
    const extractDir = path.join(tempRoot, 'extract');
    const innerDir = path.join(extractDir, 'inner');
    await fs.promises.mkdir(innerDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(innerDir, 'SKILL.md'),
      `---
name: inner-name
description: nested
---`,
      'utf8',
    );

    const result = await installLocalSkillFromExtractedContent({
      extractDir,
      fileName: 'test.zip',
      skillsDir,
    });

    expect(result.skillName).toBe('inner-name');
    expect(result.skillVersion).toBe('unknown');
    expect(fs.existsSync(path.join(result.skillDir, 'inner', 'SKILL.md'))).toBe(false);

    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });

  it.runIf(process.platform === 'win32')('extracts a ZIP archive on Windows', async () => {
    const destination = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lyclaw-zip-extract-'));
    try {
      await extractZipToDir(
        path.resolve('artifacts/digital-employee-package-example2/document-analyst-1.0.0.zip'),
        destination,
      );
      const packageRoot = await resolveDigitalEmployeePackageRoot(destination);
      const manifest = await fs.promises.readFile(path.join(packageRoot, 'employee.json'), 'utf8');
      expect(manifest).toContain('com.lyclaw.employee.document-analyst');
    } finally {
      await fs.promises.rm(destination, { recursive: true, force: true });
    }
  });
});
