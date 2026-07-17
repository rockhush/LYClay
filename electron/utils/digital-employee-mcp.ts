import type {
  DigitalEmployeePackageManifest,
  InstalledDigitalEmployeeMcpServer,
} from '../../shared/types/digital-employee';
import { statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { getBundledNodeExe } from './bundled-node';
import { validateMcpConfig } from './mcp-config-validator';
import {
  getMcpConfigPath,
  readMcpConfig,
  writeMcpConfigAtomic,
  type McpConfigFile,
  type McpServerEntry,
} from './mcp-json';

const SAFE_RUNTIME_NAME = /[^A-Za-z0-9._-]+/g;
const PLACEHOLDER_VALUE = /^(?:\$\{[A-Z0-9_]+\}|<[^>]+>)$/;
const SENSITIVE_ENV_KEY = /(?:TOKEN|SECRET|PASSWORD|PASS|API_KEY|ACCESS_KEY|PRIVATE_KEY|AUTH|CREDENTIAL)/i;
const NODE_COMMAND_NAMES = new Set(['node', 'node.exe']);
export const DIGITAL_EMPLOYEE_MCP_OWNER_KEY = 'x-lyclaw-owner';
export const DIGITAL_EMPLOYEE_MCP_HIDDEN_KEY = 'x-lyclaw-hidden-from-connectors';
export const DIGITAL_EMPLOYEE_MCP_AUTO_ENABLED_KEY = 'x-lyclaw-auto-enabled';

function isNodeCommand(command: string | undefined): boolean {
  if (!command) return false;
  return NODE_COMMAND_NAMES.has(basename(command).trim().toLowerCase());
}

function existingFile(path: string): string | undefined {
  try {
    return statSync(path).isFile() ? path : undefined;
  } catch {
    return undefined;
  }
}

export function resolveDigitalEmployeeNodeExecutable(): string | undefined {
  const bundled = existingFile(getBundledNodeExe());
  if (bundled) return bundled;

  const execBase = basename(process.execPath).trim().toLowerCase();
  if (execBase === 'node' || execBase === 'node.exe') return process.execPath;

  const binaryName = process.platform === 'win32' ? 'node.exe' : 'node';
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const trimmed = dir.trim();
    if (!trimmed) continue;
    const candidate = existingFile(join(trimmed, binaryName));
    if (candidate) return candidate;
  }
  return undefined;
}

function normalizeRuntimeCommand(entry: McpServerEntry): McpServerEntry {
  if (!isNodeCommand(entry.command)) return entry;
  const nodeExecutable = resolveDigitalEmployeeNodeExecutable();
  return nodeExecutable ? { ...entry, command: nodeExecutable } : entry;
}


function resolvePortableEntryPath(installPath: string, entry: string): string {
  const trimmed = entry.trim();
  if (!trimmed) throw new Error('runtime node entry is required');
  if (isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith('~')) {
    throw new Error('runtime node entry must be a portable relative path');
  }
  const normalized = trimmed.replace(/\\/g, '/');
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error('runtime node entry must stay inside the employee package');
  }
  const root = resolve(installPath);
  const target = resolve(root, normalized);
  const rel = relative(root, target);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('runtime node entry must stay inside the employee package');
  }
  return target;
}

function expandRuntimeDeclaration(params: {
  entry: McpServerEntry;
  installPath: string;
  sourceName?: string;
}): McpServerEntry {
  if (params.entry.runtime !== 'node') return params.entry;
  if (typeof params.entry.entry !== 'string') {
    throw new Error(`MCP server "${params.sourceName ?? 'unknown'}" runtime node requires entry`);
  }
  if (params.entry.command !== undefined) {
    throw new Error(`MCP server "${params.sourceName ?? 'unknown'}" runtime node must not also set command`);
  }
  const nodeExecutable = resolveDigitalEmployeeNodeExecutable();
  if (!nodeExecutable) {
    throw new Error('ClawX Node runtime is unavailable for digital employee MCP server');
  }
  const { runtime: _runtime, entry: entryPath, args, env, ...rest } = params.entry;
  const scriptPath = resolvePortableEntryPath(params.installPath, entryPath);
  return {
    ...rest,
    command: nodeExecutable,
    args: [scriptPath, ...(args ?? [])],
    env: {
      ...env,
      CLAWX_NODE: nodeExecutable,
      EMPLOYEE_DIR: params.installPath,
    },
  };
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function withAllowedToolFilter(entry: McpServerEntry, allowedTools?: string[]): McpServerEntry {
  const legacyTools = isObjectRecord(entry.tools) ? entry.tools : undefined;
  const existingToolFilter = isObjectRecord(entry.toolFilter) ? entry.toolFilter : {};
  const include = allowedTools?.length
    ? allowedTools
    : Array.isArray(legacyTools?.allow) && legacyTools.allow.every((tool) => typeof tool === 'string')
      ? legacyTools.allow
      : undefined;
  const exclude = Array.isArray(legacyTools?.deny) && legacyTools.deny.every((tool) => typeof tool === 'string')
    ? legacyTools.deny
    : undefined;
  const { tools: _tools, ...rest } = entry;
  if (!include?.length && !exclude?.length) return rest;
  return {
    ...rest,
    toolFilter: {
      ...existingToolFilter,
      ...(include?.length ? { include } : {}),
      ...(exclude?.length ? { exclude } : {}),
    },
  };
}

function toRuntimeName(instanceId: string, sourceName: string): string {
  const normalizedSource = sourceName.trim().replace(SAFE_RUNTIME_NAME, '-').replace(/^-+|-+$/g, '');
  if (!normalizedSource) throw new Error(`Invalid MCP server name: ${sourceName}`);
  return `${instanceId}--${normalizedSource}`;
}

function assertNoPackagedSecrets(serverName: string, entry: McpServerEntry): void {
  const env = entry.env ?? {};
  for (const [key, value] of Object.entries(env)) {
    if (SENSITIVE_ENV_KEY.test(key) && value && !PLACEHOLDER_VALUE.test(value.trim())) {
      throw new Error(`MCP server "${serverName}" contains a packaged environment value for ${key}`);
    }
  }

  const headers = entry.headers ?? {};
  for (const [key, value] of Object.entries(headers)) {
    const trimmed = value.trim();
    const placeholderOnly = PLACEHOLDER_VALUE.test(trimmed)
      || /^Bearer\s+\$\{[A-Z0-9_]+\}$/i.test(trimmed);
    if (trimmed && !placeholderOnly) {
      throw new Error(`MCP server "${serverName}" contains a packaged header value for ${key}`);
    }
  }
}

export interface InstallEmployeeMcpResult {
  installedServers: InstalledDigitalEmployeeMcpServer[];
  warnings: string[];
}

export interface UpdateEmployeeMcpResult extends InstallEmployeeMcpResult {
  previousConfig: McpConfigFile;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeTemplateEntry(entry: McpServerEntry | undefined): McpServerEntry {
  if (!entry) return {};
  if (entry.type === 'streamable-http' || entry.type === 'sse') {
    const { type, ...rest } = entry;
    return { ...rest, transport: type };
  }
  if (entry.type === 'stdio') {
    const { type: _type, ...rest } = entry;
    return rest;
  }
  return { ...entry };
}

function validateSelectedMcpServers(
  servers: Record<string, McpServerEntry>,
  runtimeNames: string[],
  label: string,
): void {
  const selected: Record<string, McpServerEntry> = Object.fromEntries(
    runtimeNames
      .filter((name) => servers[name] !== undefined)
      .map((name) => [name, servers[name] as McpServerEntry]),
  );
  const validation = validateMcpConfig({ servers: selected });
  if (!validation.valid) {
    throw new Error(`${label}: ${validation.errors.join('; ')}`);
  }
}

export function isDigitalEmployeeMcpServer(entry: McpServerEntry | undefined): boolean {
  if (!entry) return false;
  if (entry[DIGITAL_EMPLOYEE_MCP_HIDDEN_KEY] === true) return true;
  const owner = entry[DIGITAL_EMPLOYEE_MCP_OWNER_KEY];
  return Boolean(
    owner
      && typeof owner === 'object'
      && !Array.isArray(owner)
      && (owner as { type?: unknown }).type === 'digitalEmployee',
  );
}

function withEmployeeMetadata(params: {
  entry: McpServerEntry;
  sourceName: string;
  instanceId: string;
  agentId: string;
  manifest: DigitalEmployeePackageManifest;
  installPath: string;
}): McpServerEntry {
  const normalizedEntry = normalizeRuntimeCommand(expandRuntimeDeclaration({
    entry: params.entry,
    installPath: params.installPath,
    sourceName: params.sourceName,
  }));
  const next: McpServerEntry = {
    ...normalizedEntry,
    disabled: false,
    [DIGITAL_EMPLOYEE_MCP_OWNER_KEY]: {
      type: 'digitalEmployee',
      instanceId: params.instanceId,
      agentId: params.agentId,
      packageId: params.manifest.package.id,
      sourceName: params.sourceName,
    },
    [DIGITAL_EMPLOYEE_MCP_HIDDEN_KEY]: true,
    [DIGITAL_EMPLOYEE_MCP_AUTO_ENABLED_KEY]: true,
  };
  if (next.command && next.cwd === undefined && next.workingDirectory === undefined) {
    next.cwd = params.installPath;
  }
  return next;
}

function withEmployeeRuntimeDefaults(params: {
  entry: McpServerEntry;
  installPath: string;
}): McpServerEntry {
  const normalizedEntry = normalizeRuntimeCommand(expandRuntimeDeclaration({
    entry: params.entry,
    installPath: params.installPath,
  }));
  const next: McpServerEntry = {
    ...normalizedEntry,
    disabled: false,
  };
  if (next.command && next.cwd === undefined && next.workingDirectory === undefined) {
    next.cwd = params.installPath;
  }
  return next;
}

export function buildEmployeeRuntimeMcpConfig(params: {
  manifest: DigitalEmployeePackageManifest;
  packageConfig: McpConfigFile | null;
  installPath: string;
}): McpConfigFile {
  if (!params.packageConfig || Object.keys(params.packageConfig.servers).length === 0) {
    return { servers: {} };
  }

  const bindings = new Map((params.manifest.mcp?.bindings ?? []).map((binding) => [binding.server, binding]));
  const servers: Record<string, McpServerEntry> = {};

  for (const [sourceName, sourceEntry] of Object.entries(params.packageConfig.servers)) {
    assertNoPackagedSecrets(sourceName, sourceEntry);
    const binding = bindings.get(sourceName);
    servers[sourceName] = withEmployeeRuntimeDefaults({
      entry: withAllowedToolFilter(sourceEntry, binding?.allowedTools),
      installPath: params.installPath,
    });
  }

  const next: McpConfigFile = { servers };
  const validation = validateMcpConfig(next);
  if (!validation.valid) {
    throw new Error(`Employee runtime MCP configuration is invalid: ${validation.errors.join('; ')}`);
  }
  return next;
}

export async function writeEmployeeRuntimeMcpConfig(params: {
  manifest: DigitalEmployeePackageManifest;
  packageConfig: McpConfigFile | null;
  installPath: string;
  targetRoot?: string;
}): Promise<void> {
  const runtimeConfig = buildEmployeeRuntimeMcpConfig({
    manifest: params.manifest,
    packageConfig: params.packageConfig,
    installPath: params.installPath,
  });
  if (Object.keys(runtimeConfig.servers).length === 0) return;

  const targetPath = join(
    params.targetRoot ?? params.installPath,
    params.manifest.mcp?.serverTemplate?.trim() || 'mcp/servers.json',
  );
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, `${JSON.stringify(runtimeConfig, null, 2)}\n`, 'utf8');
}

export async function installEmployeeMcpServers(params: {
  instanceId: string;
  agentId: string;
  manifest: DigitalEmployeePackageManifest;
  packageConfig: McpConfigFile | null;
  installPath: string;
}): Promise<InstallEmployeeMcpResult> {
  if (!params.packageConfig || Object.keys(params.packageConfig.servers).length === 0) {
    return { installedServers: [], warnings: [] };
  }

  const current = await readMcpConfig();
  const nextServers = { ...current.servers };
  const installedServers: InstalledDigitalEmployeeMcpServer[] = [];
  const warnings: string[] = [];
  const bindings = new Map((params.manifest.mcp?.bindings ?? []).map((binding) => [binding.server, binding]));

  for (const [sourceName, sourceEntry] of Object.entries(params.packageConfig.servers)) {
    assertNoPackagedSecrets(sourceName, sourceEntry);
    const runtimeName = toRuntimeName(params.instanceId, sourceName);
    if (nextServers[runtimeName]) {
      throw new Error(`MCP runtime entry already exists: ${runtimeName}`);
    }

    const binding = bindings.get(sourceName);
    nextServers[runtimeName] = withEmployeeMetadata({
      entry: withAllowedToolFilter(sourceEntry, binding?.allowedTools),
      sourceName,
      instanceId: params.instanceId,
      agentId: params.agentId,
      manifest: params.manifest,
      installPath: params.installPath,
    });
    installedServers.push({ sourceName, runtimeName });
  }

  validateSelectedMcpServers(
    nextServers,
    installedServers.map((entry) => entry.runtimeName),
    'Installed digital employee MCP configuration is invalid',
  );
  const next: McpConfigFile = { servers: nextServers };
  await writeMcpConfigAtomic(getMcpConfigPath(), next);
  return { installedServers, warnings };
}

export async function removeEmployeeMcpServers(runtimeNames: string[]): Promise<void> {
  if (runtimeNames.length === 0) return;
  const names = new Set(runtimeNames);
  const current = await readMcpConfig();
  const next = {
    servers: Object.fromEntries(
      Object.entries(current.servers).filter(([name]) => !names.has(name)),
    ),
  };
  await writeMcpConfigAtomic(getMcpConfigPath(), next);
}

export async function updateEmployeeMcpServers(params: {
  instanceId: string;
  agentId: string;
  manifest: DigitalEmployeePackageManifest;
  previousPackageConfig: McpConfigFile | null;
  packageConfig: McpConfigFile | null;
  installedServers: InstalledDigitalEmployeeMcpServer[];
  installPath: string;
}): Promise<UpdateEmployeeMcpResult> {
  if (!params.packageConfig && params.installedServers.length === 0) {
    return { installedServers: [], warnings: [], previousConfig: { servers: {} } };
  }

  const current = await readMcpConfig();
  const nextServers = { ...current.servers };
  const previousBySource = params.previousPackageConfig?.servers ?? {};
  const nextBySource = params.packageConfig?.servers ?? {};
  const oldRuntimeBySource = new Map(
    params.installedServers.map((entry) => [entry.sourceName, entry.runtimeName]),
  );
  const installedServers: InstalledDigitalEmployeeMcpServer[] = [];
  const warnings: string[] = [];
  const bindings = new Map((params.manifest.mcp?.bindings ?? []).map((binding) => [binding.server, binding]));

  for (const [sourceName, runtimeName] of oldRuntimeBySource) {
    if (!(sourceName in nextBySource)) delete nextServers[runtimeName];
  }

  for (const [sourceName, sourceEntry] of Object.entries(nextBySource)) {
    assertNoPackagedSecrets(sourceName, sourceEntry);
    const runtimeName = oldRuntimeBySource.get(sourceName) ?? toRuntimeName(params.instanceId, sourceName);
    const currentEntry = nextServers[runtimeName];
    const previousTemplate = normalizeTemplateEntry(previousBySource[sourceName]);
    const nextTemplate = normalizeTemplateEntry(sourceEntry);
    const binding = bindings.get(sourceName);
    let merged: McpServerEntry = withAllowedToolFilter(nextTemplate, binding?.allowedTools);

    if (currentEntry) {
      for (const field of ['url', 'command', 'args', 'env', 'headers'] as const) {
        if (!sameValue(currentEntry[field], previousTemplate[field])) {
          merged[field] = currentEntry[field] as never;
        }
      }
    }
    merged = withEmployeeMetadata({
      entry: merged,
      sourceName,
      instanceId: params.instanceId,
      agentId: params.agentId,
      manifest: params.manifest,
      installPath: params.installPath,
    });
    nextServers[runtimeName] = merged;
    installedServers.push({ sourceName, runtimeName });
  }

  validateSelectedMcpServers(
    nextServers,
    installedServers.map((entry) => entry.runtimeName),
    'Updated digital employee MCP configuration is invalid',
  );
  const next: McpConfigFile = { servers: nextServers };
  await writeMcpConfigAtomic(getMcpConfigPath(), next);
  return { installedServers, warnings, previousConfig: current };
}

export async function restoreEmployeeMcpConfig(config: McpConfigFile): Promise<void> {
  await writeMcpConfigAtomic(getMcpConfigPath(), config);
}
