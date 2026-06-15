import type {
  DigitalEmployeePackageManifest,
  InstalledDigitalEmployeeMcpServer,
} from '../../shared/types/digital-employee';
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

function toRuntimeName(instanceId: string, sourceName: string): string {
  const normalizedSource = sourceName.trim().replace(SAFE_RUNTIME_NAME, '-').replace(/^-+|-+$/g, '');
  if (!normalizedSource) throw new Error(`Invalid MCP server name: ${sourceName}`);
  return `${instanceId}--${normalizedSource}`;
}

function assertNoPackagedSecrets(serverName: string, entry: McpServerEntry): void {
  const env = entry.env ?? {};
  for (const [key, value] of Object.entries(env)) {
    if (value && !PLACEHOLDER_VALUE.test(value.trim())) {
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

export async function installEmployeeMcpServers(params: {
  instanceId: string;
  manifest: DigitalEmployeePackageManifest;
  packageConfig: McpConfigFile | null;
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
    const tools = binding?.allowedTools?.length
      ? { ...(sourceEntry.tools ?? {}), allow: binding.allowedTools }
      : sourceEntry.tools;
    nextServers[runtimeName] = {
      ...sourceEntry,
      tools,
      // Marketplace MCP definitions are registered but never activated silently.
      disabled: true,
    };
    installedServers.push({ sourceName, runtimeName });
    warnings.push(`MCP server "${sourceName}" was installed disabled and requires local authorization`);
  }

  const next: McpConfigFile = { servers: nextServers };
  const validation = validateMcpConfig(next);
  if (!validation.valid) {
    throw new Error(`Installed MCP configuration is invalid: ${validation.errors.join('; ')}`);
  }
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
  manifest: DigitalEmployeePackageManifest;
  previousPackageConfig: McpConfigFile | null;
  packageConfig: McpConfigFile | null;
  installedServers: InstalledDigitalEmployeeMcpServer[];
}): Promise<UpdateEmployeeMcpResult> {
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
    const tools = binding?.allowedTools?.length
      ? { ...(nextTemplate.tools ?? {}), allow: binding.allowedTools }
      : nextTemplate.tools;
    const merged: McpServerEntry = { ...nextTemplate, tools };

    if (currentEntry) {
      for (const field of ['url', 'command', 'args', 'env', 'headers', 'disabled'] as const) {
        if (!sameValue(currentEntry[field], previousTemplate[field])) {
          merged[field] = currentEntry[field] as never;
        }
      }
    } else {
      merged.disabled = true;
      warnings.push(`MCP server "${sourceName}" was added disabled and requires local authorization`);
    }
    nextServers[runtimeName] = merged;
    installedServers.push({ sourceName, runtimeName });
  }

  const next: McpConfigFile = { servers: nextServers };
  const validation = validateMcpConfig(next);
  if (!validation.valid) {
    throw new Error(`Updated MCP configuration is invalid: ${validation.errors.join('; ')}`);
  }
  await writeMcpConfigAtomic(getMcpConfigPath(), next);
  return { installedServers, warnings, previousConfig: current };
}

export async function restoreEmployeeMcpConfig(config: McpConfigFile): Promise<void> {
  await writeMcpConfigAtomic(getMcpConfigPath(), config);
}
