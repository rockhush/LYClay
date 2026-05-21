import { access, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readOpenClawConfig, writeOpenClawConfig, type OpenClawConfig } from './channel-config';
import { withConfigLock } from './config-mutex';

export type McpTransportType = 'streamable-http' | 'stdio' | 'sse';

export interface McpServerToolsFilter {
  allow?: string[];
  deny?: string[];
}

export interface McpServerEntry {
  type?: McpTransportType;
  transport?: 'streamable-http' | 'sse';
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  disabled?: boolean;
  headers?: Record<string, string>;
  tools?: McpServerToolsFilter;
  [key: string]: unknown;
}

export interface McpConfigFile {
  servers: Record<string, McpServerEntry>;
}

export const LYCLAW_BUILTIN_MCP_KEYS = new Set(['notion', 'github']);

const OPENCLAW_DIR = join(homedir(), '.openclaw');
const OPENCLAW_CONFIG_PATH = join(OPENCLAW_DIR, 'openclaw.json');
const LEGACY_MCP_CONFIG_PATH = join(OPENCLAW_DIR, 'mcp.json');
const DISABLED_BACKUP_KEY = 'x-lyclaw-disabled-server';
const LEGACY_IMPORT_DONE_KEY = 'x-lyclaw-legacy-mcp-imported';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeServerEntry(entry: McpServerEntry): McpServerEntry {
  const next: McpServerEntry = { ...entry };
  if (next.type === 'streamable-http' || next.type === 'sse') {
    next.transport = next.type;
    delete next.type;
  } else if (next.type === 'stdio') {
    delete next.type;
  }
  return next;
}

function toRuntimeServerEntry(entry: McpServerEntry): McpServerEntry {
  const normalized = normalizeServerEntry(entry);
  if (normalized.disabled !== true) return normalized;
  const { command, args, env, cwd, workingDirectory, url, headers, transport, type, ...rest } = normalized;
  return {
    ...rest,
    disabled: true,
    [DISABLED_BACKUP_KEY]: { command, args, env, cwd, workingDirectory, url, headers, transport, type },
  };
}

function toUiServerEntry(entry: McpServerEntry): McpServerEntry {
  const backup = isRecord(entry[DISABLED_BACKUP_KEY]) ? entry[DISABLED_BACKUP_KEY] as McpServerEntry : undefined;
  const { [DISABLED_BACKUP_KEY]: _backup, ...rest } = entry;
  return backup ? { ...backup, ...rest } : rest;
}

function readServersFromConfig(config: OpenClawConfig): Record<string, McpServerEntry> {
  const mcp = isRecord(config.mcp) ? config.mcp : {};
  const servers = isRecord(mcp.servers) ? mcp.servers : {};
  return Object.fromEntries(
    Object.entries(servers)
      .filter(([, value]) => isRecord(value))
      .map(([name, value]) => [name, toUiServerEntry(value as McpServerEntry)]),
  );
}

function writeServersToConfig(config: OpenClawConfig, servers: Record<string, McpServerEntry>): void {
  const mcp = isRecord(config.mcp) ? { ...(config.mcp as Record<string, unknown>) } : {};
  mcp.servers = Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [name, toRuntimeServerEntry(server)]),
  );
  config.mcp = mcp;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readLegacyMcpFile(): Promise<Record<string, unknown> | null> {
  if (!(await fileExists(LEGACY_MCP_CONFIG_PATH))) return null;
  try {
    const raw = await readFile(LEGACY_MCP_CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function readLegacyMcpConfig(): Promise<McpConfigFile | null> {
  const parsed = await readLegacyMcpFile();
  if (!parsed || !isRecord(parsed.mcpServers)) return null;
  return {
    servers: Object.fromEntries(
      Object.entries(parsed.mcpServers)
        .filter(([, value]) => isRecord(value))
        .map(([name, value]) => [name, normalizeServerEntry(value as McpServerEntry)]),
    ),
  };
}

async function deleteLegacyMcpServerIfPresent(name: string): Promise<void> {
  const parsed = await readLegacyMcpFile();
  if (!parsed || !isRecord(parsed.mcpServers) || !(name in parsed.mcpServers)) return;
  const { [name]: _removed, ...rest } = parsed.mcpServers;
  await writeFile(
    LEGACY_MCP_CONFIG_PATH,
    `${JSON.stringify({ ...parsed, mcpServers: rest }, null, 2)}\n`,
    'utf8',
  );
}

async function importLegacyMcpIfNeeded(config: OpenClawConfig): Promise<boolean> {
  if (config[LEGACY_IMPORT_DONE_KEY] === true) return false;
  const current = readServersFromConfig(config);
  if (Object.keys(current).length > 0) return false;
  const legacy = await readLegacyMcpConfig();
  config[LEGACY_IMPORT_DONE_KEY] = true;
  if (!legacy || Object.keys(legacy.servers).length === 0) return true;
  writeServersToConfig(config, legacy.servers);
  return true;
}

export function getMcpConfigPath(): string {
  return `${OPENCLAW_CONFIG_PATH}#mcp.servers`;
}

export function emptyMcpConfig(): McpConfigFile {
  return { servers: {} };
}

export async function readMcpConfig(): Promise<McpConfigFile> {
  return withConfigLock(async () => {
    const config = await readOpenClawConfig();
    if (await importLegacyMcpIfNeeded(config)) {
      await writeOpenClawConfig(config);
    }
    return { servers: readServersFromConfig(config) };
  });
}

export async function writeMcpConfigAtomic(_path: string, config: McpConfigFile): Promise<void> {
  await withConfigLock(async () => {
    const current = await readOpenClawConfig();
    current[LEGACY_IMPORT_DONE_KEY] = true;
    writeServersToConfig(current, config.servers);
    await writeOpenClawConfig(current);
  });
}

export async function deleteMcpServerEverywhere(name: string): Promise<void> {
  await withConfigLock(async () => {
    const current = await readOpenClawConfig();
    const servers = readServersFromConfig(current);
    const { [name]: _removed, ...rest } = servers;
    current[LEGACY_IMPORT_DONE_KEY] = true;
    writeServersToConfig(current, rest);
    await writeOpenClawConfig(current);
    await deleteLegacyMcpServerIfPresent(name);
  });
}

export function mergeGithubInstall(config: McpConfigFile, token: string): McpConfigFile {
  return {
    servers: {
      ...config.servers,
      github: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: token },
        disabled: false,
      },
    },
  };
}

export function mergeNotionInstall(config: McpConfigFile, apiKey: string): McpConfigFile {
  return {
    servers: {
      ...config.servers,
      notion: {
        command: 'npx',
        args: ['-y', '@notionhq/notion-mcp-server'],
        env: { NOTION_API_KEY: apiKey },
        disabled: false,
      },
    },
  };
}
