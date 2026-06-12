import * as fs from 'fs';
import * as path from 'path';
import { getOpenClawConfigDir } from './paths';
import { logger } from './logger';
import { readUiState, writeUiState, type LyclawUiState } from './ui-state';

const PRESERVED_SKILLS_DIR = '.lyclaw/preserved-skills';

function normalizePathKey(value: string): string {
  return path.resolve(value).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function rewritePathValue(currentPath: string, fromPath: string, toPath: string): string {
  const normalizedCurrent = path.resolve(currentPath);
  const normalizedFrom = path.resolve(fromPath);
  const normalizedTo = path.resolve(toPath);
  if (normalizePathKey(normalizedCurrent) === normalizePathKey(normalizedFrom)) {
    return normalizedTo;
  }
  const fromWithSep = normalizedFrom.endsWith(path.sep) ? normalizedFrom : `${normalizedFrom}${path.sep}`;
  if (normalizedCurrent.startsWith(fromWithSep)) {
    return path.join(normalizedTo, normalizedCurrent.slice(fromWithSep.length));
  }
  return currentPath;
}

export function rewriteUiStateWorkspacePaths(
  state: LyclawUiState,
  fromPath: string,
  toPath: string,
): LyclawUiState {
  const next: LyclawUiState = {
    ...state,
    workspaces: {
      ...state.workspaces,
      temporaryWorkspaces: state.workspaces.temporaryWorkspaces.map((workspace) => ({
        ...workspace,
        path: rewritePathValue(workspace.path, fromPath, toPath),
      })),
      currentWorkspacePath: state.workspaces.currentWorkspacePath
        ? rewritePathValue(state.workspaces.currentWorkspacePath, fromPath, toPath)
        : null,
    },
  };
  return next;
}

export function getPreservedSkillDirectory(slug: string): string {
  const safeSlug = slug.trim() || 'skill';
  return path.join(getOpenClawConfigDir(), PRESERVED_SKILLS_DIR, safeSlug);
}

export function hasPreservedSkillDirectory(slug: string): boolean {
  const preservedDir = getPreservedSkillDirectory(slug);
  return fs.existsSync(preservedDir);
}

async function removeDirectoryIfExists(targetDir: string): Promise<void> {
  if (!fs.existsSync(targetDir)) return;
  await fs.promises.rm(targetDir, { recursive: true, force: true });
}

export async function preserveSkillDirectoryOnUninstall(
  skillDir: string,
  slug: string,
): Promise<string | null> {
  const resolvedSkillDir = path.resolve(skillDir);
  if (!fs.existsSync(resolvedSkillDir)) {
    return null;
  }

  const preservedDir = path.resolve(getPreservedSkillDirectory(slug));
  await fs.promises.mkdir(path.dirname(preservedDir), { recursive: true });
  await removeDirectoryIfExists(preservedDir);

  try {
    await fs.promises.rename(resolvedSkillDir, preservedDir);
  } catch (error) {
    logger.warn('[skill-preserve] rename failed, falling back to copy+remove', {
      skillDir: resolvedSkillDir,
      preservedDir,
      error: String(error),
    });
    await fs.promises.cp(resolvedSkillDir, preservedDir, { recursive: true, force: true });
    await fs.promises.rm(resolvedSkillDir, { recursive: true, force: true });
  }

  try {
    const currentState = readUiState();
    const nextState = rewriteUiStateWorkspacePaths(currentState, resolvedSkillDir, preservedDir);
    writeUiState(nextState);
  } catch (error) {
    logger.warn('[skill-preserve] Failed to rewrite UI workspace paths after preserve', {
      error: String(error),
    });
  }

  logger.info('[skill-preserve] Preserved skill directory on uninstall', {
    slug,
    from: resolvedSkillDir,
    to: preservedDir,
  });
  return preservedDir;
}

export async function restorePreservedSkillDirectory(
  slug: string,
  skillDir: string,
): Promise<boolean> {
  const preservedDir = path.resolve(getPreservedSkillDirectory(slug));
  const resolvedSkillDir = path.resolve(skillDir);
  if (!fs.existsSync(preservedDir)) {
    return false;
  }

  await fs.promises.mkdir(path.dirname(resolvedSkillDir), { recursive: true });
  await removeDirectoryIfExists(resolvedSkillDir);

  try {
    await fs.promises.rename(preservedDir, resolvedSkillDir);
  } catch (error) {
    logger.warn('[skill-preserve] restore rename failed, falling back to copy+remove', {
      preservedDir,
      skillDir: resolvedSkillDir,
      error: String(error),
    });
    await fs.promises.cp(preservedDir, resolvedSkillDir, { recursive: true, force: true });
    await fs.promises.rm(preservedDir, { recursive: true, force: true });
  }

  try {
    const currentState = readUiState();
    const nextState = rewriteUiStateWorkspacePaths(currentState, preservedDir, resolvedSkillDir);
    writeUiState(nextState);
  } catch (error) {
    logger.warn('[skill-preserve] Failed to rewrite UI workspace paths after restore', {
      error: String(error),
    });
  }

  logger.info('[skill-preserve] Restored preserved skill directory on install', {
    slug,
    from: preservedDir,
    to: resolvedSkillDir,
  });
  return true;
}
