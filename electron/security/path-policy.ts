import path from 'node:path';
import { homedir } from 'node:os';
import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { getDataDir, getOpenClawConfigDir, getOpenClawSkillsDir } from '../utils/paths';
import { readOpenClawConfig } from '../utils/channel-config';
import { readUiState } from '../utils/ui-state';
import { matchSensitivePath } from './sensitive-paths';
import type { FileCapability, PathPolicyRequest, PathPolicyResult, ResolvedPathInfo, SecurityDecision } from './types';
import { auditPathDecision } from './audit-log';
import { findPathGrant, isPathInside, samePath } from './permission-store';

function allow(reasons: string[], risk: SecurityDecision['risk'] = 'low'): SecurityDecision {
  return { action: 'allow', risk, reasons };
}

function deny(code: string, reasons: string[], risk: SecurityDecision['risk'] = 'high'): SecurityDecision {
  return { action: 'deny', risk, reasons, code };
}

function expandHome(inputPath: string): string {
  if (inputPath === '~') return homedir();
  return inputPath.replace(/^~(?=$|[\\/])/, homedir());
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function realpathExistingOrParent(absolutePath: string): Promise<{ realPath: string; exists: boolean; parentRealPath?: string }> {
  if (await exists(absolutePath)) {
    return { realPath: await realpath(absolutePath), exists: true };
  }

  const parent = path.dirname(absolutePath);
  const parentRealPath = await realpath(parent);
  return {
    realPath: path.join(parentRealPath, path.basename(absolutePath)),
    parentRealPath,
    exists: false,
  };
}

export async function resolvePathInfo(inputPath: string, baseDir?: string): Promise<ResolvedPathInfo> {
  if (typeof inputPath !== 'string' || !inputPath.trim()) {
    throw new Error('Path must be a non-empty string');
  }

  const expanded = expandHome(inputPath.trim());
  const absolutePath = path.resolve(baseDir ? expandHome(baseDir) : process.cwd(), expanded);
  const normalizedAbsolutePath = path.normalize(absolutePath);
  const resolved = await realpathExistingOrParent(normalizedAbsolutePath);

  return {
    inputPath,
    absolutePath: normalizedAbsolutePath,
    realPath: resolved.realPath,
    parentRealPath: resolved.parentRealPath,
    exists: resolved.exists,
  };
}

async function rootToRealPath(rootPath: string): Promise<string | null> {
  try {
    return (await resolvePathInfo(rootPath)).realPath;
  } catch {
    return null;
  }
}

function collectAgentWorkspaces(config: Record<string, unknown>): string[] {
  const workspaces = new Set<string>();
  const agents = config.agents && typeof config.agents === 'object'
    ? config.agents as Record<string, unknown>
    : {};
  const defaults = agents.defaults && typeof agents.defaults === 'object'
    ? agents.defaults as Record<string, unknown>
    : {};
  const defaultWorkspace = defaults.workspace;
  if (typeof defaultWorkspace === 'string' && defaultWorkspace.trim()) {
    workspaces.add(defaultWorkspace);
  }

  const list = Array.isArray(agents.list) ? agents.list : [];
  for (const entry of list) {
    if (entry && typeof entry === 'object') {
      const workspace = (entry as Record<string, unknown>).workspace;
      if (typeof workspace === 'string' && workspace.trim()) {
        workspaces.add(workspace);
      }
    }
  }

  if (workspaces.size === 0) {
    workspaces.add(path.join(getOpenClawConfigDir(), 'workspace'));
  }

  return [...workspaces];
}

function collectUiWorkspaces(): string[] {
  const workspaces = new Set<string>();
  const uiState = readUiState();
  const currentWorkspacePath = uiState.workspaces.currentWorkspacePath;
  if (currentWorkspacePath?.trim()) {
    workspaces.add(currentWorkspacePath);
  }

  for (const workspace of uiState.workspaces.temporaryWorkspaces) {
    if (workspace.path.trim()) {
      workspaces.add(workspace.path);
    }
  }

  return [...workspaces];
}

async function getBuiltInAllowedRoots(): Promise<string[]> {
  const roots = new Set<string>();
  roots.add(path.join(getOpenClawConfigDir(), 'media', 'outbound'));
  roots.add(path.join(getDataDir(), 'logs'));
  roots.add(getOpenClawSkillsDir());

  try {
    for (const workspace of collectUiWorkspaces()) {
      roots.add(expandHome(workspace));
    }
  } catch {
    // UI state is best-effort; explicit grants and OpenClaw config still apply.
  }

  try {
    const config = await readOpenClawConfig() as Record<string, unknown>;
    for (const workspace of collectAgentWorkspaces(config)) {
      roots.add(expandHome(workspace));
    }
  } catch {
    roots.add(path.join(getOpenClawConfigDir(), 'workspace'));
  }

  return [...roots];
}

async function findAllowedRoot(realPath: string, roots: string[]): Promise<string | null> {
  for (const root of roots) {
    const realRoot = await rootToRealPath(root);
    if (!realRoot) continue;
    if (isPathInside(realPath, realRoot)) {
      return realRoot;
    }
  }
  return null;
}

function isSymlinkEscape(pathInfo: ResolvedPathInfo, matchedRoot: string | null): boolean {
  if (!matchedRoot) return false;
  const lexicalRoot = path.normalize(matchedRoot);
  const lexicalInside = isPathInside(pathInfo.absolutePath, lexicalRoot);
  const realInside = isPathInside(pathInfo.realPath, lexicalRoot);
  return lexicalInside && !realInside;
}

function isDirectoryCapabilityAllowed(pathInfo: ResolvedPathInfo, capability: FileCapability): boolean {
  if (!pathInfo.exists) return capability === 'write';
  if (capability !== 'execute') return true;
  return false;
}

export async function evaluatePathPolicy(request: PathPolicyRequest): Promise<PathPolicyResult> {
  let pathInfo: ResolvedPathInfo;
  try {
    pathInfo = await resolvePathInfo(request.path, request.baseDir);
  } catch (error) {
    const result: PathPolicyResult = {
      decision: deny('PATH_RESOLUTION_FAILED', [`Cannot resolve path: ${error instanceof Error ? error.message : String(error)}`]),
    };
    auditPathDecision(request, result);
    return result;
  }

  const sensitive = matchSensitivePath(pathInfo.realPath) ?? matchSensitivePath(pathInfo.absolutePath);
  if (sensitive) {
    const result: PathPolicyResult = {
      pathInfo,
      decision: deny('SENSITIVE_PATH', [`Sensitive path blocked: ${sensitive.reason}`], 'critical'),
    };
    auditPathDecision(request, result);
    return result;
  }

  const grant = await findPathGrant(pathInfo.realPath, request.capability);
  if (grant) {
    const result: PathPolicyResult = {
      pathInfo,
      matchedRoot: grant.realPath,
      decision: allow([`Allowed by ${grant.source} path grant`]),
    };
    auditPathDecision(request, result);
    return result;
  }

  const roots = [...(request.allowedRoots ?? []), ...(await getBuiltInAllowedRoots())];
  const matchedRoot = await findAllowedRoot(pathInfo.realPath, roots);
  if (!matchedRoot) {
    const result: PathPolicyResult = {
      pathInfo,
      decision: deny('PATH_OUTSIDE_AUTHORIZED_ROOTS', ['Path is outside authorized workspaces or session grants']),
    };
    auditPathDecision(request, result);
    return result;
  }

  if (isSymlinkEscape(pathInfo, matchedRoot)) {
    const result: PathPolicyResult = {
      pathInfo,
      matchedRoot,
      decision: deny('SYMLINK_ESCAPE', ['Path resolves outside its authorized root']),
    };
    auditPathDecision(request, result);
    return result;
  }

  if (request.capability === 'delete') {
    const result: PathPolicyResult = {
      pathInfo,
      matchedRoot,
      decision: deny('DELETE_REQUIRES_CONFIRMATION', ['Delete operations require a confirmation flow'], 'high'),
    };
    auditPathDecision(request, result);
    return result;
  }

  if (request.capability === 'execute') {
    const result: PathPolicyResult = {
      pathInfo,
      matchedRoot,
      decision: deny('EXECUTE_REQUIRES_COMMAND_POLICY', ['Execute operations are deferred to the command security policy'], 'high'),
    };
    auditPathDecision(request, result);
    return result;
  }

  if (!isDirectoryCapabilityAllowed(pathInfo, request.capability)) {
    const result: PathPolicyResult = {
      pathInfo,
      matchedRoot,
      decision: deny('CAPABILITY_NOT_ALLOWED', [`Capability ${request.capability} is not allowed for this path`]),
    };
    auditPathDecision(request, result);
    return result;
  }

  const result: PathPolicyResult = {
    pathInfo,
    matchedRoot,
    decision: allow(['Path is inside an authorized root']),
  };
  auditPathDecision(request, result);
  return result;
}

export async function assertPathAllowed(request: PathPolicyRequest): Promise<ResolvedPathInfo> {
  const result = await evaluatePathPolicy(request);
  if (result.decision.action !== 'allow' || !result.pathInfo) {
    throw new Error(result.decision.reasons.join('; ') || 'Path access denied');
  }
  return result.pathInfo;
}

export async function assertPathInsideRoot(filePath: string, rootPath: string): Promise<ResolvedPathInfo> {
  const [pathInfo, rootInfo] = await Promise.all([
    resolvePathInfo(filePath),
    resolvePathInfo(rootPath),
  ]);
  if (isPathInside(pathInfo.realPath, rootInfo.realPath) || samePath(pathInfo.realPath, rootInfo.realPath)) {
    return pathInfo;
  }
  throw new Error(`Path is outside required root: ${filePath}`);
}

export async function assertExistingFile(filePath: string): Promise<void> {
  const info = await stat(filePath);
  if (!info.isFile()) {
    throw new Error(`Expected file path: ${filePath}`);
  }
}
