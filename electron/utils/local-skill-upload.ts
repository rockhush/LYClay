import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { locateSkillContentDir, parseSkillManifestFields, resolveLocalUploadSkillMetadata } from './company-skill-package';
import { restorePreservedSkillDirectory } from './skill-workspace-preserve';
import {
  readZipEntries,
  validateZipStructure,
  validateExtractedSkill,
} from './skill-validator';

const execFileAsync = promisify(execFile);

export function resolveLocalUploadPackageDirName(fileName: string): string {
  const trimmed = fileName.trim();
  const base = path.basename(trimmed);
  const withoutExt = base.replace(/\.zip$/i, '').trim();
  if (!withoutExt) {
    throw new Error('Invalid zip file name');
  }
  return withoutExt;
}

async function runArchiveCommand(command: string, args: string[]): Promise<void> {
  await execFileAsync(command, args, { windowsHide: true });
}

async function extractZipToDir(zipPath: string, destDir: string): Promise<void> {
  await fs.promises.mkdir(destDir, { recursive: true });

  if (process.platform === 'win32') {
    try {
      await runArchiveCommand('tar.exe', ['-xf', zipPath, '-C', destDir]);
      return;
    } catch {
      const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      await runArchiveCommand(powershell, [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        'Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force',
        zipPath,
        destDir,
      ]);
      return;
    }
  }

  await runArchiveCommand('unzip', ['-o', zipPath, '-d', destDir]);
}

export async function installLocalSkillFromExtractedContent(params: {
  extractDir: string;
  fileName: string;
  skillsDir: string;
}): Promise<{ skillName: string; skillVersion: string; skillDir: string }> {
  const packageDirName = resolveLocalUploadPackageDirName(params.fileName);
  const skillDir = path.join(params.skillsDir, packageDirName);

  if (await restorePreservedSkillDirectory(packageDirName, skillDir)) {
    const manifestPath = path.join(skillDir, 'SKILL.md');
    const manifestRaw = await fs.promises.readFile(manifestPath, 'utf8');
    const metadata = resolveLocalUploadSkillMetadata(
      parseSkillManifestFields(manifestRaw),
      packageDirName,
    );
    return {
      skillName: metadata.name,
      skillVersion: metadata.version,
      skillDir,
    };
  }

  const contentDir = await locateSkillContentDir(params.extractDir);

  // ── P0 SECURITY: Post-extraction validation on actual content dir ──
  const postValidationResult = validateExtractedSkill(contentDir);
  if (!postValidationResult.allowed) {
    const err = new Error(postValidationResult.blockReason || 'Content security check failed');
    (err as any).errorCode = 'CONTENT_BLOCKED';
    (err as any).validationResult = postValidationResult;
    throw err;
  }

  await fs.promises.mkdir(params.skillsDir, { recursive: true });
  await fs.promises.rm(skillDir, { recursive: true, force: true });
  await fs.promises.cp(contentDir, skillDir, { recursive: true, force: true });

  const manifestPath = path.join(skillDir, 'SKILL.md');
  const manifestRaw = await fs.promises.readFile(manifestPath, 'utf8');
  const metadata = resolveLocalUploadSkillMetadata(
    parseSkillManifestFields(manifestRaw),
    packageDirName,
  );

  return {
    skillName: metadata.name,
    skillVersion: metadata.version,
    skillDir,
  };
}

export async function installLocalSkillZip(params: {
  fileName: string;
  buffer: Buffer;
  skillsDir: string;
  tempRoot: string;
}): Promise<{ skillName: string; skillVersion: string; skillDir: string }> {
  const tempExtractDir = path.join(params.tempRoot, `lyclaw-upload-${Date.now()}`);
  const tempZipPath = path.join(params.tempRoot, `.upload_${Date.now()}.zip`);

  await fs.promises.mkdir(tempExtractDir, { recursive: true });

  try {
    await fs.promises.writeFile(tempZipPath, params.buffer);

    // ── P0 SECURITY: Pre-extraction validation ──────────────────────
    let entries;
    try {
      entries = readZipEntries(tempZipPath);
    } catch (zipReadError) {
      throw new Error('ZIP 文件读取失败，文件可能已损坏或不是有效的格式');
    }

    if (entries.length === 0) {
      throw new Error('ZIP 文件为空，请检查文件是否正确');
    }

    const preValidationResult = validateZipStructure(entries, tempZipPath);
    if (!preValidationResult.allowed) {
      const err = new Error(preValidationResult.blockReason || 'Security check failed');
      (err as any).errorCode = 'SECURITY_BLOCKED';
      (err as any).validationResult = preValidationResult;
      throw err;
    }

    await extractZipToDir(tempZipPath, tempExtractDir);

    return await installLocalSkillFromExtractedContent({
      extractDir: tempExtractDir,
      fileName: params.fileName,
      skillsDir: params.skillsDir,
    });
  } finally {
    await fs.promises.rm(tempZipPath, { force: true }).catch(() => undefined);
    await fs.promises.rm(tempExtractDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
