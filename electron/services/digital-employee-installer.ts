import { createHash, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { access, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  DigitalEmployeeInstallRecord,
  InstallDigitalEmployeeInput,
  InstallDigitalEmployeeResult,
} from '../../shared/types/digital-employee';
import {
  createAgentWithResult,
  deleteAgentConfig,
  updateAgentModel,
  removeAgentWorkspaceDirectory,
  type AgentSummary,
} from '../utils/agent-config';
import {
  publishPreparedEmployeeDirectory,
  findInstalledDigitalEmployeeByPackageId,
  getDigitalEmployeeInstallPath,
  removeDigitalEmployeeDirectory,
  writeInstallRecord,
} from '../utils/digital-employee-storage';
import {
  validateDigitalEmployeeZip,
  validateExtractedDigitalEmployeePackage,
  type ValidatedDigitalEmployeePackage,
} from '../utils/digital-employee-package';
import { extractZipToDir } from '../utils/local-skill-upload';
import { installEmployeeMcpServers, removeEmployeeMcpServers, writeEmployeeRuntimeMcpConfig } from '../utils/digital-employee-mcp';
import { ensureClawXContext } from '../utils/openclaw-workspace';
import { expandPath } from '../utils/paths';
import { proxyAwareFetch } from '../utils/proxy-fetch';
import { syncDigitalEmployeeSub2ApiModels } from './sub2api/model-sync-service';
import { reactivateHistoricalDigitalEmployeeAgentsForActive } from '../utils/historical-digital-employee-agents';
import * as logger from '../utils/logger';
import { syncAgentModelOverrideToRuntime } from './providers/provider-runtime-sync';

export const MANAGED_AGENT_WORKSPACE_FILES = [
  'AGENTS.md',
  'SOUL.md',
  'TOOLS.md',
  'USER.md',
  'IDENTITY.md',
  'HEARTBEAT.md',
  'BOOT.md',
] as const;

export const MANAGED_AGENT_WORKSPACE_DIRECTORIES = [
  'resources',
] as const;

export const DIGITAL_EMPLOYEE_DOWNLOAD_BASE_URL =
  'https://ai.lingyiitech.com/management/agents/download/';
export const MAX_DIGITAL_EMPLOYEE_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const TRUSTED_DIGITAL_EMPLOYEE_DOWNLOAD_HOST = new URL(
  DIGITAL_EMPLOYEE_DOWNLOAD_BASE_URL,
).hostname;

type RollbackAction = {
  label: string;
  run: () => Promise<void>;
};

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export interface DigitalEmployeeInstallerDependencies {
  downloadPackage: (input: InstallDigitalEmployeeInput, targetZipPath: string) => Promise<void>;
  validateZip: (zipPath: string) => void;
  extractPackage: (zipPath: string, extractDir: string) => Promise<void>;
  validatePackage: (extractDir: string) => Promise<ValidatedDigitalEmployeePackage>;
  findInstalledByPackageId: typeof findInstalledDigitalEmployeeByPackageId;
  createAgent: (
    name: string,
    options: { preferredId: string; modelRef: string | null; inheritWorkspace?: boolean },
  ) => Promise<{ createdAgent: AgentSummary }>;
  deleteAgent: (agentId: string) => Promise<void>;
  ensureContext: typeof ensureClawXContext;
  syncSub2ApiModels: typeof syncDigitalEmployeeSub2ApiModels;
  updateAgentModel: typeof updateAgentModel;
  syncAgentRuntimeModel: typeof syncAgentModelOverrideToRuntime;
}

export async function downloadDigitalEmployeePackage(
  input: InstallDigitalEmployeeInput,
  targetZipPath: string,
): Promise<void> {
  let url = buildDigitalEmployeeDownloadUrl(input.marketEmployeeId);
  let response: Awaited<ReturnType<typeof proxyAwareFetch>> | null = null;
  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    if (url.protocol !== 'https:') {
      throw new Error('Digital employee package URL must use HTTPS');
    }
    await assertPublicDownloadHost(url.hostname);
    response = await proxyAwareFetch(url, { redirect: 'manual' });
    if (response.status < 300 || response.status >= 400) break;
    const location = response.headers.get('location');
    if (!location) throw new Error(`Package download redirect ${response.status} has no location`);
    if (redirectCount === 5) throw new Error('Digital employee package download has too many redirects');
    url = new URL(location, url);
  }
  if (!response) throw new Error('Digital employee package download failed');
  if (!response.ok) throw new Error(`Package download failed with HTTP ${response.status}`);
  const contentLength = Number(response.headers.get('content-length') ?? '0');
  if (
    Number.isFinite(contentLength)
    && contentLength > MAX_DIGITAL_EMPLOYEE_DOWNLOAD_BYTES
  ) {
    throw new Error('Digital employee package download is too large');
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_DIGITAL_EMPLOYEE_DOWNLOAD_BYTES) {
    throw new Error('Digital employee package download is too large');
  }
  if (input.packageSha256) {
    const actual = createHash('sha256').update(buffer).digest('hex');
    if (actual.toLowerCase() !== input.packageSha256.trim().toLowerCase()) {
      throw new Error('Digital employee package SHA-256 does not match');
    }
  }
  await writeFile(targetZipPath, buffer);
}

export function buildDigitalEmployeeDownloadUrl(marketEmployeeId: string | number): URL {
  const normalizedId = String(marketEmployeeId).trim();
  if (!/^[1-9]\d*$/.test(normalizedId)) {
    throw new Error('marketEmployeeId must be a positive integer');
  }
  return new URL(
    `${encodeURIComponent(normalizedId)}/`,
    DIGITAL_EMPLOYEE_DOWNLOAD_BASE_URL,
  );
}

function isPrivateAddress(address: string): boolean {
  if (address === '::1' || address === '0.0.0.0' || address === '::') return true;
  if (address.startsWith('fc') || address.startsWith('fd') || address.startsWith('fe80:')) return true;
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  return parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

export function isTrustedDigitalEmployeeDownloadHost(hostname: string): boolean {
  return hostname.trim().toLowerCase() === TRUSTED_DIGITAL_EMPLOYEE_DOWNLOAD_HOST;
}

async function assertPublicDownloadHost(hostname: string): Promise<void> {
  const normalized = hostname.trim().toLowerCase();
  if (!normalized || normalized === 'localhost' || normalized.endsWith('.localhost')) {
    throw new Error('Digital employee package URL cannot target a local host');
  }
  // The marketplace API is a fixed, application-owned endpoint and may resolve
  // to an internal company address. Redirects to any other private host remain blocked.
  if (isTrustedDigitalEmployeeDownloadHost(normalized)) return;
  if (isIP(normalized)) {
    if (isPrivateAddress(normalized)) throw new Error('Digital employee package URL cannot target a private address');
    return;
  }
  const addresses = await lookup(normalized, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error('Digital employee package URL resolved to a private address');
  }
}

async function deleteCreatedAgent(agentId: string): Promise<void> {
  const { removedEntry } = await deleteAgentConfig(agentId);
  await removeAgentWorkspaceDirectory(removedEntry);
}

const defaultDependencies: DigitalEmployeeInstallerDependencies = {
  downloadPackage: downloadDigitalEmployeePackage,
  validateZip: validateDigitalEmployeeZip,
  extractPackage: extractZipToDir,
  validatePackage: validateExtractedDigitalEmployeePackage,
  findInstalledByPackageId: findInstalledDigitalEmployeeByPackageId,
  createAgent: async (name, options) => createAgentWithResult(name, {
    inheritWorkspace: options.inheritWorkspace,
    preferredId: options.preferredId,
    modelRef: options.modelRef,
  }),
  deleteAgent: deleteCreatedAgent,
  ensureContext: ensureClawXContext,
  syncSub2ApiModels: syncDigitalEmployeeSub2ApiModels,
  updateAgentModel,
  syncAgentRuntimeModel: syncAgentModelOverrideToRuntime,
};

export function createDigitalEmployeeInstallerDependencies(
  overrides: Partial<DigitalEmployeeInstallerDependencies> = {},
): DigitalEmployeeInstallerDependencies {
  return { ...defaultDependencies, ...overrides };
}

let installQueue = Promise.resolve();

export async function withDigitalEmployeeInstallLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = installQueue;
  let release: () => void = () => undefined;
  installQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

function packageIdSlug(packageId: string): string {
  const candidate = packageId.split('.').filter(Boolean).at(-1) ?? '';
  const slug = candidate
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 48);
  return slug || 'digital-employee';
}

export function createDigitalEmployeeInstallIdentity(
  packageId: string,
  suffix = randomBytes(4).toString('hex'),
): { instanceId: string; agentId: string } {
  const slug = packageIdSlug(packageId);
  const normalizedSuffix = suffix.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
  if (!normalizedSuffix) throw new Error('Digital employee identity suffix is invalid');
  return {
    instanceId: `${slug}-${normalizedSuffix}`,
    agentId: `employee-${slug}-${normalizedSuffix}`,
  };
}

async function syncAgentWorkspaceResourceDirectories(
  packageInfo: ValidatedDigitalEmployeePackage,
  workspaceDir: string,
): Promise<void> {
  for (const dirName of MANAGED_AGENT_WORKSPACE_DIRECTORIES) {
    const source = join(packageInfo.rootDir, dirName);
    const target = join(workspaceDir, dirName);
    if (await fileExists(source)) {
      await rm(target, { recursive: true, force: true });
      await cp(source, target, { recursive: true, force: true });
    }
  }
}

async function writeAgentWorkspace(
  packageInfo: ValidatedDigitalEmployeePackage,
  agent: AgentSummary,
): Promise<void> {
  const sourceDir = join(packageInfo.rootDir, packageInfo.manifest.agent.workspaceSource);
  const workspaceDir = expandPath(agent.workspace);
  await mkdir(workspaceDir, { recursive: true });
  let copied = 0;

  for (const fileName of MANAGED_AGENT_WORKSPACE_FILES) {
    const source = join(sourceDir, fileName);
    try {
      const target = join(workspaceDir, fileName);
      if (fileName === 'USER.md' && await fileExists(target)) {
        continue;
      }
      const content = await readFile(source);
      const tempTarget = join(workspaceDir, `${fileName}.employee-install.tmp`);
      await writeFile(tempTarget, content);
      await rename(tempTarget, target);
      copied += 1;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
    }
  }

  await syncAgentWorkspaceResourceDirectories(packageInfo, workspaceDir);

  if (copied === 0) throw new Error('Digital employee package contains no supported Agent workspace files');
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

export async function installDigitalEmployee(
  input: InstallDigitalEmployeeInput,
  dependencies: DigitalEmployeeInstallerDependencies = defaultDependencies,
): Promise<InstallDigitalEmployeeResult> {
  const marketEmployeeId = String(input.marketEmployeeId).trim();
  if (!marketEmployeeId) throw new Error('marketEmployeeId is required');
  buildDigitalEmployeeDownloadUrl(marketEmployeeId);

  return withDigitalEmployeeInstallLock(async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), `lyclaw-employee-${randomBytes(6).toString('hex')}-`));
    const zipPath = join(tempRoot, 'employee.zip');
    const extractDir = join(tempRoot, 'extract');
    const preparedDir = join(tempRoot, 'prepared');
    const rollback: RollbackAction[] = [];
    let publishedDir: string | null = null;

    try {
      await dependencies.downloadPackage(input, zipPath);
      dependencies.validateZip(zipPath);
      await mkdir(extractDir, { recursive: true });
      await dependencies.extractPackage(zipPath, extractDir);
      const packageInfo = await dependencies.validatePackage(extractDir);
      if (packageInfo.manifest.install?.allowMultipleInstances === false) {
        const existing = await dependencies.findInstalledByPackageId(
          packageInfo.manifest.package.id,
        );
        if (existing) {
          throw new Error(
            `Digital employee package "${packageInfo.manifest.package.id}" is already installed`
            + ` as instance "${existing.instanceId}" and does not allow multiple instances`,
          );
        }
      }
      const { instanceId, agentId } = createDigitalEmployeeInstallIdentity(
        packageInfo.manifest.package.id,
      );

      await cp(packageInfo.rootDir, preparedDir, { recursive: true, force: false });
      const agentName = packageInfo.agentTemplate?.name || packageInfo.manifest.package.name;
      const modelRef = packageInfo.agentTemplate?.model
        ?? packageInfo.manifest.agent.modelRef
        ?? null;
      const { createdAgent } = await dependencies.createAgent(agentName, {
        preferredId: agentId,
        modelRef,
        inheritWorkspace: true,
      });
      rollback.push({
        label: `delete Agent ${createdAgent.id}`,
        run: () => dependencies.deleteAgent(createdAgent.id),
      });

      await writeAgentWorkspace(packageInfo, createdAgent);
      await dependencies.ensureContext();

      const warnings = [...packageInfo.warnings];
      const finalPath = getDigitalEmployeeInstallPath(instanceId);
      await writeEmployeeRuntimeMcpConfig({
        manifest: packageInfo.manifest,
        packageConfig: packageInfo.mcpConfig,
        installPath: finalPath,
        targetRoot: preparedDir,
      });
      const mcpResult = await installEmployeeMcpServers({
        instanceId,
        agentId: createdAgent.id,
        manifest: packageInfo.manifest,
        packageConfig: packageInfo.mcpConfig,
        installPath: finalPath,
      });
      rollback.push({
        label: 'remove installed employee MCP servers',
        run: () => removeEmployeeMcpServers(mcpResult.installedServers.map((server) => server.runtimeName)),
      });
      warnings.push(...mcpResult.warnings);
      const status = warnings.length > 0 ? 'degraded' : 'active';
      const record: DigitalEmployeeInstallRecord = {
        schemaVersion: 1,
        instanceId,
        marketEmployeeId,
        packageId: packageInfo.manifest.package.id,
        packageVersion: packageInfo.manifest.package.version,
        installPath: finalPath,
        agentId: createdAgent.id,
        agentWorkspace: expandPath(createdAgent.workspace),
        packagedSkills: (packageInfo.manifest.skills ?? []).map((skill) => ({
          slug: skill.slug,
          path: skill.path,
          required: skill.required,
        })),
        installedMcpServers: mcpResult.installedServers,
        status,
        installedAt: new Date().toISOString(),
        warnings,
      };
      await writeInstallRecord(preparedDir, record);
      publishedDir = await publishPreparedEmployeeDirectory(preparedDir, instanceId);
      rollback.push({
        label: 'remove published employee directory',
        run: () => removeDigitalEmployeeDirectory(publishedDir!),
      });

      const sub2ApiResult = await dependencies.syncSub2ApiModels({
        manifest: packageInfo.manifest,
        marketEmployeeId,
        instanceId,
        agentId: createdAgent.id,
      }, 'install');
      if (sub2ApiResult.status === 'success' && sub2ApiResult.defaultModel) {
        await dependencies.updateAgentModel(createdAgent.id, sub2ApiResult.defaultModel);
        await dependencies.syncAgentRuntimeModel(createdAgent.id).catch(() => undefined);
      } else if (sub2ApiResult.status !== 'skipped-missing-subject') {
        warnings.push(`Sub2API model sync skipped: ${sub2ApiResult.errorCode ?? sub2ApiResult.status}`);
      }

      try {
        const reactivatedHistoricalAgents = await reactivateHistoricalDigitalEmployeeAgentsForActive(
          createdAgent.id,
          agentName,
        );
        if (reactivatedHistoricalAgents.length > 0) {
          logger.info('Reactivated historical digital employee session agents after install', {
            activeAgentId: createdAgent.id,
            reactivatedHistoricalAgents,
          });
        }
      } catch (error) {
        warnings.push(`Historical session reactivation skipped: ${String(error)}`);
        logger.warn('Failed to reactivate historical digital employee session agents after install', {
          activeAgentId: createdAgent.id,
          error: String(error),
        });
      }

      return {
        instanceId,
        agentId: createdAgent.id,
        sessionKey: `agent:${createdAgent.id}:main`,
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
