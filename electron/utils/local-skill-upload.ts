import { execFile } from 'child_process';
import crypto from 'node:crypto';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { locateSkillContentDir, parseSkillManifestFields, resolveLocalUploadSkillMetadata } from './company-skill-package';
import { restorePreservedSkillDirectory } from './skill-workspace-preserve';
import { findSkillGrant, grantSkillAccess } from '../security/permission-store';
import {
  DEFAULT_SKILL_WORKSPACE_PERMISSIONS,
  diffSkillManifestPermissions,
  requiresSkillPermissionConfirmation,
  type SkillManifestPermissionDiff,
  type SkillManifestPermissions,
} from '../security/skill-permission-policy';
import type { SkillUploadConfirmationStore } from '../security/skill-upload-confirmation';
import {
  readZipEntries,
  validateZipStructure,
  validateExtractedSkill,
  type ExtractedValidationResult,
} from './skill-validator';

const execFileAsync = promisify(execFile);

type UploadValidationStage = 'pre-extraction' | 'post-extraction' | 'preview';

type UploadValidationResult = Pick<ExtractedValidationResult, 'riskLevel' | 'findings' | 'summary'> & {
  stage: UploadValidationStage;
};

export type InstalledLocalSkillUploadResult = {
  skillName: string;
  skillVersion: string;
  skillDir: string;
  preview?: false;
};

export type LocalSkillPermissionPreviewResult = {
  preview: true;
  skillName: string;
  confirmationToken: string;
  permissions: SkillManifestPermissions;
  permissionDiff: SkillManifestPermissionDiff;
  validationResult: UploadValidationResult;
};

export type LocalSkillUploadResult = InstalledLocalSkillUploadResult | LocalSkillPermissionPreviewResult;

type PermissionConfirmationOptions = {
  autoInstall?: boolean;
  confirmationToken?: string;
  confirmationStore?: SkillUploadConfirmationStore;
  fileDigest?: string;
  source?: string;
};

function defaultSkillPermissions(): SkillManifestPermissions {
  return {
    filesystem: [...DEFAULT_SKILL_WORKSPACE_PERMISSIONS],
    network: [],
    commands: [],
    secrets: [],
  };
}

function buildValidationResult(
  validation: Pick<ExtractedValidationResult, 'riskLevel' | 'findings' | 'summary'>,
  stage: UploadValidationStage,
): UploadValidationResult {
  return {
    riskLevel: validation.riskLevel,
    findings: validation.findings,
    summary: validation.summary,
    stage,
  };
}

async function getExistingManifestDigest(skillDir: string): Promise<string | null> {
  const existingManifestPath = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(existingManifestPath)) return null;
  return crypto.createHash('sha256')
    .update(await fs.promises.readFile(existingManifestPath))
    .digest('hex');
}

async function buildPermissionGate(params: {
  fileName: string;
  fileDigest?: string;
  skillId: string;
  skillDir: string;
  manifestRaw: Buffer | string;
  permissions: SkillManifestPermissions;
  validation: Pick<ExtractedValidationResult, 'riskLevel' | 'findings' | 'summary'>;
  options?: PermissionConfirmationOptions;
}): Promise<{ manifestDigest: string; preview?: LocalSkillUploadResult }> {
  const manifestDigest = crypto.createHash('sha256').update(params.manifestRaw).digest('hex');
  const existingManifestDigest = await getExistingManifestDigest(params.skillDir);
  const existingGrant = existingManifestDigest
    ? await findSkillGrant(params.skillId, existingManifestDigest)
    : null;
  const permissionDiff = diffSkillManifestPermissions(existingGrant?.permissions, params.permissions);
  const requiresConfirmation = requiresSkillPermissionConfirmation(permissionDiff);

  if (!requiresConfirmation) {
    return { manifestDigest };
  }

  const options = params.options ?? {};
  const fileDigest = params.fileDigest ?? options.fileDigest;

  if (!options.autoInstall) {
    if (!options.confirmationStore || !fileDigest) {
      throw new Error('Skill installation requires a permission confirmation store');
    }
    return {
      manifestDigest,
      preview: {
        preview: true,
        skillName: params.skillId,
        confirmationToken: options.confirmationStore.create(params.fileName, fileDigest),
        permissions: params.permissions,
        permissionDiff,
        validationResult: buildValidationResult(params.validation, 'preview'),
      },
    };
  }

  if (!options.confirmationStore?.consume(options.confirmationToken, params.fileName, fileDigest ?? '')) {
    const err = new Error('Skill installation requires a fresh permission confirmation');
    (err as any).errorCode = 'SKILL_PERMISSION_CONFIRMATION_REQUIRED';
    throw err;
  }

  return { manifestDigest };
}

export function resolveLocalUploadPackageDirName(fileName: string): string {
  const trimmed = fileName.trim();
  const base = path.basename(trimmed);
  const withoutExt = base.replace(/\.zip$/i, '').trim();
  if (!withoutExt) {
    throw new Error('Invalid zip file name');
  }
  return withoutExt;
}

async function runArchiveCommand(
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  await execFileAsync(command, args, { windowsHide: true, env });
}

export async function extractZipToDir(zipPath: string, destDir: string): Promise<void> {
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
        'Expand-Archive -LiteralPath $env:CLAWX_ARCHIVE_PATH -DestinationPath $env:CLAWX_ARCHIVE_DEST -Force',
      ], {
        ...process.env,
        CLAWX_ARCHIVE_PATH: zipPath,
        CLAWX_ARCHIVE_DEST: destDir,
      });
      return;
    }
  }

  await runArchiveCommand('unzip', ['-o', zipPath, '-d', destDir]);
}

type InstallLocalSkillFromExtractedContentParams = {
  extractDir: string;
  fileName: string;
  skillsDir: string;
  permissionConfirmation?: PermissionConfirmationOptions;
};


export async function installLocalSkillFromExtractedContent(params: InstallLocalSkillFromExtractedContentParams): Promise<LocalSkillUploadResult> {
  const packageDirName = resolveLocalUploadPackageDirName(params.fileName);
  const skillDir = path.join(params.skillsDir, packageDirName);

  if (await restorePreservedSkillDirectory(packageDirName, skillDir)) {
    const manifestPath = path.join(skillDir, 'SKILL.md');
    const manifestRaw = await fs.promises.readFile(manifestPath);
    const metadata = resolveLocalUploadSkillMetadata(
      parseSkillManifestFields(manifestRaw.toString('utf8')),
      packageDirName,
    );
    const validation = validateExtractedSkill(skillDir);
    const permissions = validation.permissionResult?.permissions ?? defaultSkillPermissions();
    const { manifestDigest } = await buildPermissionGate({
      fileName: params.fileName,
      skillId: metadata.name,
      skillDir,
      manifestRaw,
      permissions,
      validation,
      options: params.permissionConfirmation,
    });
    await grantSkillAccess(metadata.name, manifestDigest, permissions, {
      source: params.permissionConfirmation?.source ?? 'skill:uploadZip',
    });
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
    (err as any).validationResult = buildValidationResult(postValidationResult, 'post-extraction');
    throw err;
  }

  const manifestPath = path.join(contentDir, 'SKILL.md');
  const manifestRaw = await fs.promises.readFile(manifestPath);
  const permissions = postValidationResult.permissionResult?.permissions ?? defaultSkillPermissions();

  await fs.promises.mkdir(params.skillsDir, { recursive: true });
  const metadata = resolveLocalUploadSkillMetadata(
    parseSkillManifestFields(manifestRaw.toString('utf8')),
    packageDirName,
  );
  const gate = await buildPermissionGate({
    fileName: params.fileName,
    fileDigest: params.permissionConfirmation?.fileDigest,
    skillId: metadata.name,
    skillDir,
    manifestRaw,
    permissions,
    validation: postValidationResult,
    options: params.permissionConfirmation,
  });
  if (gate.preview) return gate.preview;

  await fs.promises.rm(skillDir, { recursive: true, force: true });
  await fs.promises.cp(contentDir, skillDir, { recursive: true, force: true });
  await grantSkillAccess(metadata.name, gate.manifestDigest, permissions, {
    source: params.permissionConfirmation?.source ?? 'skill:uploadZip',
  });

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
  autoInstall?: boolean;
  confirmationToken?: string;
  confirmationStore?: SkillUploadConfirmationStore;
}): Promise<LocalSkillUploadResult> {
  const tempExtractDir = path.join(params.tempRoot, `lyclaw-upload-${Date.now()}`);
  const tempZipPath = path.join(params.tempRoot, `.upload_${Date.now()}.zip`);
  const fileDigest = crypto.createHash('sha256').update(params.buffer).digest('hex');

  await fs.promises.mkdir(tempExtractDir, { recursive: true });

  try {
    await fs.promises.writeFile(tempZipPath, params.buffer);

    // ── P0 SECURITY: Pre-extraction validation ──────────────────────
    let entries;
    try {
      entries = readZipEntries(tempZipPath);
    } catch (zipReadError) {
      throw new Error('ZIP file read failed; the archive may be damaged or invalid');
    }

    if (entries.length === 0) {
      throw new Error('ZIP file is empty');
    }

    const preValidationResult = validateZipStructure(entries, tempZipPath);
    if (!preValidationResult.allowed) {
      const err = new Error(preValidationResult.blockReason || 'Security check failed');
      (err as any).errorCode = 'SECURITY_BLOCKED';
      (err as any).validationResult = {
        riskLevel: preValidationResult.riskLevel,
        findings: preValidationResult.findings,
        summary: preValidationResult.summary,
        stage: 'pre-extraction',
      };
      throw err;
    }

    await extractZipToDir(tempZipPath, tempExtractDir);

    return await installLocalSkillFromExtractedContent({
      extractDir: tempExtractDir,
      fileName: params.fileName,
      skillsDir: params.skillsDir,
      permissionConfirmation: {
        autoInstall: params.autoInstall,
        confirmationToken: params.confirmationToken,
        confirmationStore: params.confirmationStore,
        fileDigest,
        source: 'skill:uploadZip',
      },
    });
  } finally {
    await fs.promises.rm(tempZipPath, { force: true }).catch(() => undefined);
    await fs.promises.rm(tempExtractDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
