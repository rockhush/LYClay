import { randomBytes } from 'node:crypto';
import {
  access,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  DigitalEmployeeInstallRecord,
  UpdateDigitalEmployeeInput,
  UpdateDigitalEmployeeResult,
} from '../../shared/types/digital-employee';
import {
  listAgentsSnapshot,
  updateAgentDefinition,
  type AgentSummary,
} from '../utils/agent-config';
import {
  validateDigitalEmployeeZip,
  validateExtractedDigitalEmployeePackage,
  type ValidatedDigitalEmployeePackage,
} from '../utils/digital-employee-package';
import {
  getDigitalEmployeeInstallPath,
  readInstallRecord,
  writeInstallRecord,
} from '../utils/digital-employee-storage';
import { restoreEmployeeMcpConfig, updateEmployeeMcpServers, writeEmployeeRuntimeMcpConfig } from '../utils/digital-employee-mcp';
import type { McpConfigFile } from '../utils/mcp-json';
import { extractZipToDir } from '../utils/local-skill-upload';
import { expandPath } from '../utils/paths';
import {
  downloadDigitalEmployeePackage,
  MANAGED_AGENT_WORKSPACE_DIRECTORIES,
  MANAGED_AGENT_WORKSPACE_FILES,
  withDigitalEmployeeInstallLock,
} from './digital-employee-installer';

type RollbackAction = { label: string; run: () => Promise<void> };
const UPDATE_MANAGED_WORKSPACE_FILES = MANAGED_AGENT_WORKSPACE_FILES.filter(
  (fileName) => fileName !== 'USER.md',
);

export interface DigitalEmployeeUpdaterDependencies {
  downloadPackage: (
    input: { marketEmployeeId: string; packageSha256?: string },
    targetZipPath: string,
  ) => Promise<void>;
  validateZip: (zipPath: string) => void;
  extractPackage: (zipPath: string, extractDir: string) => Promise<void>;
  validatePackage: (extractDir: string) => Promise<ValidatedDigitalEmployeePackage>;
  getAgent: (agentId: string) => Promise<AgentSummary>;
  updateAgent: (
    agentId: string,
    updates: { name: string; modelRef: string | null },
  ) => Promise<void>;
}

const defaultDependencies: DigitalEmployeeUpdaterDependencies = {
  downloadPackage: downloadDigitalEmployeePackage,
  validateZip: validateDigitalEmployeeZip,
  extractPackage: extractZipToDir,
  validatePackage: validateExtractedDigitalEmployeePackage,
  getAgent: async (agentId) => {
    const agent = (await listAgentsSnapshot()).agents.find((entry) => entry.id === agentId);
    if (!agent) throw new Error(`Bound Agent "${agentId}" not found`);
    return agent;
  },
  updateAgent: async (agentId, updates) => {
    await updateAgentDefinition(agentId, updates);
  },
};

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function renameWithRetry(source: string, target: string): Promise<void> {
  const maxAttempts = process.platform === 'win32' ? 6 : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        attempt === maxAttempts
        || (code !== 'EPERM' && code !== 'EBUSY')
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 50));
    }
  }
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string): { numbers: number[]; prerelease: string | null } => {
    const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
    if (!match) throw new Error(`Unsupported package version: ${value}`);
    return {
      numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
      prerelease: match[4] ?? null,
    };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] - b.numbers[index];
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  return a.prerelease.localeCompare(b.prerelease, 'en', { numeric: true });
}

async function backupManagedWorkspace(workspace: string, backupDir: string): Promise<Set<string>> {
  const existing = new Set<string>();
  await mkdir(backupDir, { recursive: true });
  for (const fileName of UPDATE_MANAGED_WORKSPACE_FILES) {
    const source = join(workspace, fileName);
    if (!(await pathExists(source))) continue;
    existing.add(fileName);
    await copyFile(source, join(backupDir, fileName));
  }
  for (const dirName of MANAGED_AGENT_WORKSPACE_DIRECTORIES) {
    const source = join(workspace, dirName);
    if (!(await pathExists(source))) continue;
    existing.add(`${dirName}/`);
    await cp(source, join(backupDir, dirName), { recursive: true, force: true });
  }
  return existing;
}

async function readInstalledPackageMcpConfig(installPath: string): Promise<McpConfigFile | null> {
  const manifestPath = join(installPath, 'employee.json');
  if (!(await pathExists(manifestPath))) return null;
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    mcp?: { serverTemplate?: unknown };
  };
  const templatePath = typeof manifest.mcp?.serverTemplate === 'string'
    ? join(installPath, manifest.mcp.serverTemplate)
    : null;
  if (!templatePath || !(await pathExists(templatePath))) return null;
  return JSON.parse(await readFile(templatePath, 'utf8')) as McpConfigFile;
}

async function syncManagedWorkspace(
  packageInfo: ValidatedDigitalEmployeePackage,
  workspace: string,
): Promise<void> {
  const sourceDir = join(packageInfo.rootDir, packageInfo.manifest.agent.workspaceSource);
  await mkdir(workspace, { recursive: true });
  for (const fileName of UPDATE_MANAGED_WORKSPACE_FILES) {
    const source = join(sourceDir, fileName);
    const target = join(workspace, fileName);
    if (await pathExists(source)) {
      const tempTarget = `${target}.employee-update.tmp`;
      await copyFile(source, tempTarget);
      await rename(tempTarget, target);
    } else {
      await rm(target, { force: true });
    }
  }
  for (const dirName of MANAGED_AGENT_WORKSPACE_DIRECTORIES) {
    const source = join(packageInfo.rootDir, dirName);
    const target = join(workspace, dirName);
    await rm(target, { recursive: true, force: true });
    if (await pathExists(source)) {
      await cp(source, target, { recursive: true, force: true });
    }
  }
}

async function restoreManagedWorkspace(
  workspace: string,
  backupDir: string,
  existing: Set<string>,
): Promise<void> {
  for (const fileName of UPDATE_MANAGED_WORKSPACE_FILES) {
    const target = join(workspace, fileName);
    if (existing.has(fileName)) {
      await copyFile(join(backupDir, fileName), target);
    } else {
      await rm(target, { force: true });
    }
  }
  for (const dirName of MANAGED_AGENT_WORKSPACE_DIRECTORIES) {
    const target = join(workspace, dirName);
    await rm(target, { recursive: true, force: true });
    if (existing.has(`${dirName}/`)) {
      await cp(join(backupDir, dirName), target, { recursive: true, force: true });
    }
  }
}

async function runRollback(actions: RollbackAction[]): Promise<string[]> {
  const errors: string[] = [];
  for (const action of [...actions].reverse()) {
    try {
      await action.run();
    } catch (error) {
      errors.push(`${action.label}: ${String(error)}`);
    }
  }
  return errors;
}

export async function updateDigitalEmployee(
  instanceId: string,
  input: UpdateDigitalEmployeeInput,
  dependencies: DigitalEmployeeUpdaterDependencies = defaultDependencies,
): Promise<UpdateDigitalEmployeeResult> {
  if (!instanceId.trim()) throw new Error('instanceId is required');

  return withDigitalEmployeeInstallLock(async () => {
    const installPath = getDigitalEmployeeInstallPath(instanceId);
    const currentRecord = await readInstallRecord(installPath);
    const previousMcpConfig = await readInstalledPackageMcpConfig(installPath);
    const currentAgent = await dependencies.getAgent(currentRecord.agentId);
    const tempRoot = await mkdtemp(join(tmpdir(), `lyclaw-employee-update-${randomBytes(6).toString('hex')}-`));
    const zipPath = join(tempRoot, 'employee.zip');
    const extractDir = join(tempRoot, 'extract');
    const preparedDir = join(tempRoot, 'prepared');
    const workspaceBackup = join(tempRoot, 'workspace-backup');
    const packageBackup = join(
      dirname(installPath),
      '.update-backups',
      `${instanceId}-${randomBytes(4).toString('hex')}`,
    );
    const rollback: RollbackAction[] = [];

    try {
      await dependencies.downloadPackage({
        marketEmployeeId: currentRecord.marketEmployeeId,
        packageSha256: input.packageSha256,
      }, zipPath);
      dependencies.validateZip(zipPath);
      await mkdir(extractDir, { recursive: true });
      await dependencies.extractPackage(zipPath, extractDir);
      const packageInfo = await dependencies.validatePackage(extractDir);

      if (packageInfo.manifest.package.id !== currentRecord.packageId) {
        throw new Error('Update packageId does not match the installed digital employee');
      }
      if (compareVersions(packageInfo.manifest.package.version, currentRecord.packageVersion) <= 0) {
        throw new Error(
          `Update version ${packageInfo.manifest.package.version} must be newer than`
          + ` installed version ${currentRecord.packageVersion}`,
        );
      }

      await cp(packageInfo.rootDir, preparedDir, { recursive: true, force: false });
      await mkdir(dirname(packageBackup), { recursive: true });
      await renameWithRetry(installPath, packageBackup);
      rollback.push({
        label: 'restore employee package',
        run: async () => {
          await rm(installPath, { recursive: true, force: true });
          await renameWithRetry(packageBackup, installPath);
        },
      });
      await renameWithRetry(preparedDir, installPath);

      const workspace = expandPath(currentRecord.agentWorkspace);
      const existingWorkspaceFiles = await backupManagedWorkspace(workspace, workspaceBackup);
      rollback.push({
        label: 'restore Agent workspace',
        run: () => restoreManagedWorkspace(workspace, workspaceBackup, existingWorkspaceFiles),
      });
      await syncManagedWorkspace(packageInfo, workspace);

      const nextName = packageInfo.agentTemplate?.name || packageInfo.manifest.package.name;
      const nextModel = packageInfo.agentTemplate?.model
        ?? packageInfo.manifest.agent.modelRef
        ?? null;
      rollback.push({
        label: 'restore Agent definition',
        run: () => dependencies.updateAgent(currentRecord.agentId, {
          name: currentAgent.name,
          modelRef: currentAgent.overrideModelRef,
        }),
      });
      await dependencies.updateAgent(currentRecord.agentId, {
        name: nextName,
        modelRef: nextModel,
      });

      const warnings = [...packageInfo.warnings];
      await writeEmployeeRuntimeMcpConfig({
        manifest: packageInfo.manifest,
        packageConfig: packageInfo.mcpConfig,
        installPath,
      });
      const mcpResult = await updateEmployeeMcpServers({
        instanceId,
        agentId: currentRecord.agentId,
        manifest: packageInfo.manifest,
        previousPackageConfig: previousMcpConfig,
        packageConfig: packageInfo.mcpConfig,
        installedServers: currentRecord.installedMcpServers ?? [],
        installPath,
      });
      rollback.push({
        label: 'restore employee MCP config',
        run: () => restoreEmployeeMcpConfig(mcpResult.previousConfig),
      });
      warnings.push(...mcpResult.warnings);
      const status = warnings.length > 0 ? 'degraded' : 'active';
      const updatedAt = new Date().toISOString();
      const nextRecord: DigitalEmployeeInstallRecord = {
        ...currentRecord,
        packageVersion: packageInfo.manifest.package.version,
        packagedSkills: (packageInfo.manifest.skills ?? []).map((skill) => ({
          slug: skill.slug,
          path: skill.path,
          required: skill.required,
        })),
        installedMcpServers: mcpResult.installedServers,
        status,
        updatedAt,
        updateHistory: [
          ...(currentRecord.updateHistory ?? []),
          {
            fromVersion: currentRecord.packageVersion,
            toVersion: packageInfo.manifest.package.version,
            updatedAt,
          },
        ],
        warnings,
      };
      await writeInstallRecord(installPath, nextRecord);
      await rm(packageBackup, { recursive: true, force: true }).catch(() => undefined);

      return {
        instanceId,
        agentId: currentRecord.agentId,
        sessionKey: `agent:${currentRecord.agentId}:main`,
        fromVersion: currentRecord.packageVersion,
        toVersion: packageInfo.manifest.package.version,
        status,
        warnings,
      };
    } catch (error) {
      const rollbackErrors = await runRollback(rollback);
      if (rollbackErrors.length > 0) {
        throw new Error(
          `${String(error)}; rollback incomplete: ${rollbackErrors.join(' | ')}`,
          { cause: error },
        );
      }
      throw error;
    } finally {
      await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });
}
