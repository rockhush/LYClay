import crypto from 'node:crypto';
import path from 'node:path';
import { homedir } from 'node:os';
import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import type {
  CommandCapability,
  CommandGrant,
  DomainGrant,
  FileCapability,
  McpServerCapability,
  McpServerGrant,
  NetworkCapability,
  PathGrant,
  SkillGrant,
} from './types';
import { getDataDir } from '../utils/paths';
import { auditPermissionGrant, auditPermissionInvalidate, auditPermissionRevoke } from './audit-log';
import { buildMcpServerFingerprint, getMcpServerTransport } from './mcp-server-policy';
import type { McpServerEntry } from '../utils/mcp-json';

const sessionPathGrants: PathGrant[] = [];
let persistentPathGrants: PathGrant[] | null = null;
const sessionDomainGrants: DomainGrant[] = [];
let persistentDomainGrants: DomainGrant[] | null = null;
const sessionCommandGrants: CommandGrant[] = [];
let persistentCommandGrants: CommandGrant[] | null = null;
const sessionMcpServerGrants: McpServerGrant[] = [];
let persistentMcpServerGrants: McpServerGrant[] | null = null;
let persistentSkillGrants: SkillGrant[] | null = null;

// Expired grants are treated the same as revoked grants at decision time. They
// may remain on disk until pruning so a settings/audit UI can still explain
// what used to be allowed.
function isExpired(grant: PathGrant | DomainGrant | CommandGrant | McpServerGrant, now = Date.now()): boolean {
  return typeof grant.expiresAt === 'number' && grant.expiresAt <= now;
}

function isActive(grant: PathGrant | DomainGrant | CommandGrant | McpServerGrant | SkillGrant, now = Date.now()): boolean {
  const invalidated = 'invalidatedAt' in grant && typeof grant.invalidatedAt === 'number';
  const expired = 'expiresAt' in grant && typeof grant.expiresAt === 'number' && grant.expiresAt <= now;
  return !grant.revokedAt && !invalidated && !expired;
}

function getPermissionsFilePath(): string {
  return process.env.CLAWX_SECURITY_PERMISSIONS_PATH
    || path.join(getDataDir(), 'security-permissions.json');
}

async function loadPersistentPathGrants(): Promise<PathGrant[]> {
  if (persistentPathGrants) return persistentPathGrants;
  try {
    const raw = await readFile(getPermissionsFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as { pathGrants?: unknown };
    persistentPathGrants = Array.isArray(parsed.pathGrants)
      ? parsed.pathGrants.filter(isValidGrant)
      : [];
  } catch {
    persistentPathGrants = [];
  }
  return persistentPathGrants;
}

async function loadPersistentDomainGrants(): Promise<DomainGrant[]> {
  if (persistentDomainGrants) return persistentDomainGrants;
  try {
    const raw = await readFile(getPermissionsFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as { domainGrants?: unknown };
    persistentDomainGrants = Array.isArray(parsed.domainGrants)
      ? parsed.domainGrants.filter(isValidDomainGrant)
      : [];
  } catch {
    persistentDomainGrants = [];
  }
  return persistentDomainGrants;
}

async function loadPersistentCommandGrants(): Promise<CommandGrant[]> {
  if (persistentCommandGrants) return persistentCommandGrants;
  try {
    const raw = await readFile(getPermissionsFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as { commandGrants?: unknown };
    persistentCommandGrants = Array.isArray(parsed.commandGrants)
      ? parsed.commandGrants.filter(isValidCommandGrant)
      : [];
  } catch {
    persistentCommandGrants = [];
  }
  return persistentCommandGrants;
}

async function loadPersistentMcpServerGrants(): Promise<McpServerGrant[]> {
  if (persistentMcpServerGrants) return persistentMcpServerGrants;
  try {
    const raw = await readFile(getPermissionsFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as { mcpServerGrants?: unknown };
    persistentMcpServerGrants = Array.isArray(parsed.mcpServerGrants)
      ? parsed.mcpServerGrants.filter(isValidMcpServerGrant)
      : [];
  } catch {
    persistentMcpServerGrants = [];
  }
  return persistentMcpServerGrants;
}

async function loadPersistentSkillGrants(): Promise<SkillGrant[]> {
  if (persistentSkillGrants) return persistentSkillGrants;
  try {
    const raw = await readFile(getPermissionsFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as { skillGrants?: unknown };
    persistentSkillGrants = Array.isArray(parsed.skillGrants)
      ? parsed.skillGrants.filter(isValidSkillGrant)
      : [];
  } catch {
    persistentSkillGrants = [];
  }
  return persistentSkillGrants;
}

async function savePersistentGrants(): Promise<void> {
  const pathGrants = persistentPathGrants ?? (await loadPersistentPathGrants());
  const domainGrants = persistentDomainGrants ?? (await loadPersistentDomainGrants());
  const commandGrants = persistentCommandGrants ?? (await loadPersistentCommandGrants());
  const mcpServerGrants = persistentMcpServerGrants ?? (await loadPersistentMcpServerGrants());
  const skillGrants = persistentSkillGrants ?? (await loadPersistentSkillGrants());
  const filePath = getPermissionsFilePath();
  await mkdir(path.dirname(filePath), { recursive: true });
  // Keep all security grant families in the same file so future settings UI can
  // show and revoke them together without merging multiple stores.
  await writeFile(filePath, `${JSON.stringify({ version: 1, pathGrants, domainGrants, commandGrants, mcpServerGrants, skillGrants }, null, 2)}\n`, 'utf8');
}

function isValidGrant(value: unknown): value is PathGrant {
  if (!value || typeof value !== 'object') return false;
  const grant = value as Partial<PathGrant>;
  return (
    typeof grant.id === 'string'
    && typeof grant.path === 'string'
    && typeof grant.realPath === 'string'
    && typeof grant.recursive === 'boolean'
    && Array.isArray(grant.capabilities)
    && grant.capabilities.every((capability) => typeof capability === 'string')
    && grant.scope === 'persistent'
  );
}

function isValidDomainGrant(value: unknown): value is DomainGrant {
  if (!value || typeof value !== 'object') return false;
  const grant = value as Partial<DomainGrant>;
  return (
    typeof grant.id === 'string'
    && grant.resourceType === 'domain'
    && typeof grant.domain === 'string'
    && typeof grant.includeSubdomains === 'boolean'
    && Array.isArray(grant.capabilities)
    && grant.capabilities.every((capability) => typeof capability === 'string')
    && grant.scope === 'persistent'
  );
}

function isValidCommandGrant(value: unknown): value is CommandGrant {
  if (!value || typeof value !== 'object') return false;
  const grant = value as Partial<CommandGrant>;
  return (
    typeof grant.id === 'string'
    && grant.resourceType === 'command'
    && typeof grant.command === 'string'
    && typeof grant.fingerprint === 'string'
    && Array.isArray(grant.capabilities)
    && grant.capabilities.every((capability) => typeof capability === 'string')
    && grant.scope === 'persistent'
  );
}

function isValidMcpServerGrant(value: unknown): value is McpServerGrant {
  if (!value || typeof value !== 'object') return false;
  const grant = value as Partial<McpServerGrant>;
  return (
    typeof grant.id === 'string'
    && grant.resourceType === 'mcpServer'
    && typeof grant.serverName === 'string'
    && typeof grant.transport === 'string'
    && typeof grant.fingerprint === 'string'
    && Array.isArray(grant.capabilities)
    && grant.capabilities.every((capability) => typeof capability === 'string')
    && grant.scope === 'persistent'
  );
}

function isValidSkillGrant(value: unknown): value is SkillGrant {
  if (!value || typeof value !== 'object') return false;
  const grant = value as Partial<SkillGrant>;
  const permissions = grant.permissions;
  return (
    typeof grant.id === 'string'
    && grant.subject === 'skill'
    && grant.resourceType === 'skill'
    && typeof grant.skillId === 'string'
    && typeof grant.manifestDigest === 'string'
    && Boolean(permissions && typeof permissions === 'object')
    && Array.isArray(permissions?.filesystem)
    && permissions.filesystem.every((capability) => typeof capability === 'string')
    && Array.isArray(permissions?.network)
    && permissions.network.every((capability) => typeof capability === 'string')
    && Array.isArray(permissions?.commands)
    && permissions.commands.every((capability) => typeof capability === 'string')
    && Array.isArray(permissions?.secrets)
    && permissions.secrets.every((capability) => typeof capability === 'string')
    && Array.isArray(grant.capabilities)
    && grant.capabilities.every((capability) => typeof capability === 'string')
    && grant.scope === 'persistent'
  );
}

export async function grantPathAccess(
  filePath: string,
  options: {
    capabilities: FileCapability[];
    recursive?: boolean;
    persistent?: boolean;
    subject?: PathGrant['subject'];
    resourceType?: PathGrant['resourceType'];
    source?: string;
    ttlMs?: number;
  },
): Promise<PathGrant> {
  const pathInfo = await resolveGrantPathInfo(filePath);
  const persistent = options.persistent ?? false;
  // Store both the user-visible normalized path and the real path. Policy
  // checks use realPath so symlinks cannot escape an approved workspace.
  const grant: PathGrant = {
    id: crypto.randomUUID(),
    subject: options.subject ?? 'user',
    resourceType: options.resourceType ?? (options.recursive ? 'directory' : 'file'),
    path: pathInfo.absolutePath,
    realPath: pathInfo.realPath,
    recursive: options.recursive ?? false,
    capabilities: [...new Set(options.capabilities)],
    scope: persistent ? 'persistent' : 'session',
    source: options.source ?? 'unknown',
    createdAt: Date.now(),
    ...(options.ttlMs ? { expiresAt: Date.now() + options.ttlMs } : {}),
  };
  if (persistent) {
    const grants = await loadPersistentPathGrants();
    grants.push(grant);
    await savePersistentGrants();
  } else {
    sessionPathGrants.push(grant);
  }
  auditPermissionGrant(grant);
  return grant;
}

function normalizeDomain(domain: string): string {
  const trimmed = domain.trim().toLowerCase();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    return parsed.hostname.toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');
  } catch {
    const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    const host = withoutScheme.split(/[/?#:]/, 1)[0] ?? '';
    return host.replace(/^\.+/, '').replace(/\.+$/, '');
  }
}

function domainMatches(hostname: string, domain: string, includeSubdomains: boolean): boolean {
  const host = normalizeDomain(hostname);
  const normalizedDomain = normalizeDomain(domain);
  // Avoid suffix spoofing: "api.openai.com.evil.test" must not match
  // "openai.com"; only exact domains or dot-delimited subdomains match.
  return host === normalizedDomain || (includeSubdomains && host.endsWith(`.${normalizedDomain}`));
}

export async function grantDomainAccess(
  domain: string,
  options: {
    capabilities?: NetworkCapability[];
    includeSubdomains?: boolean;
    persistent?: boolean;
    subject?: DomainGrant['subject'];
    source?: string;
    ttlMs?: number;
  } = {},
): Promise<DomainGrant> {
  const normalizedDomain = normalizeDomain(domain);
  if (!normalizedDomain) {
    throw new Error('Domain must be a non-empty string');
  }
  // Domain grants represent a user's confirmation for outbound network access.
  // They can allow explicitly configured intranet hosts, but never override
  // protocol, localhost-port, link-local metadata, or credentialed URL denials.
  const persistent = options.persistent ?? false;
  const grant: DomainGrant = {
    id: crypto.randomUUID(),
    subject: options.subject ?? 'user',
    resourceType: 'domain',
    domain: normalizedDomain,
    includeSubdomains: options.includeSubdomains ?? true,
    capabilities: [...new Set<NetworkCapability>(options.capabilities ?? ['connect'])],
    scope: persistent ? 'persistent' : 'session',
    source: options.source ?? 'unknown',
    createdAt: Date.now(),
    ...(options.ttlMs ? { expiresAt: Date.now() + options.ttlMs } : {}),
  };
  if (persistent) {
    const grants = await loadPersistentDomainGrants();
    grants.push(grant);
    await savePersistentGrants();
  } else {
    sessionDomainGrants.push(grant);
  }
  auditPermissionGrant(grant);
  return grant;
}

function normalizeCommandFingerprintValue(value: string | undefined): string {
  const trimmed = (value ?? '').trim();
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

export function buildCommandGrantFingerprint(input: {
  command: string;
  cwd?: string;
  source?: string;
}): string {
  const raw = [
    normalizeCommandFingerprintValue(input.command),
    normalizeCommandFingerprintValue(input.cwd),
    normalizeCommandFingerprintValue(input.source ?? 'unknown'),
  ].join('\n');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export async function grantCommandAccess(
  command: string,
  options: {
    cwd?: string;
    capabilities?: CommandCapability[];
    persistent?: boolean;
    subject?: CommandGrant['subject'];
    source?: string;
    ttlMs?: number;
  } = {},
): Promise<CommandGrant> {
  const normalizedCommand = command.trim();
  if (!normalizedCommand) {
    throw new Error('Command must be a non-empty string');
  }

  const persistent = options.persistent ?? false;
  const source = options.source ?? 'unknown';
  const grant: CommandGrant = {
    id: crypto.randomUUID(),
    subject: options.subject ?? 'user',
    resourceType: 'command',
    command: normalizedCommand,
    fingerprint: buildCommandGrantFingerprint({ command: normalizedCommand, cwd: options.cwd, source }),
    ...(options.cwd ? { cwd: options.cwd } : {}),
    capabilities: [...new Set<CommandCapability>(options.capabilities ?? ['execute'])],
    scope: persistent ? 'persistent' : 'session',
    source,
    createdAt: Date.now(),
    ...(options.ttlMs ? { expiresAt: Date.now() + options.ttlMs } : {}),
  };

  if (persistent) {
    const grants = await loadPersistentCommandGrants();
    grants.push(grant);
    await savePersistentGrants();
  } else {
    sessionCommandGrants.push(grant);
  }
  auditPermissionGrant(grant);
  return grant;
}

export async function grantMcpServerAccess(
  serverName: string,
  server: McpServerEntry,
  options: {
    capabilities?: McpServerCapability[];
    persistent?: boolean;
    subject?: McpServerGrant['subject'];
    source?: string;
    ttlMs?: number;
  } = {},
): Promise<McpServerGrant> {
  const normalizedName = serverName.trim();
  if (!normalizedName) throw new Error('MCP server name must be a non-empty string');
  const persistent = options.persistent ?? false;
  const grant: McpServerGrant = {
    id: crypto.randomUUID(),
    subject: options.subject ?? 'user',
    resourceType: 'mcpServer',
    serverName: normalizedName,
    transport: getMcpServerTransport(server),
    fingerprint: buildMcpServerFingerprint(normalizedName, server),
    capabilities: [...new Set<McpServerCapability>(options.capabilities ?? ['enable'])],
    scope: persistent ? 'persistent' : 'session',
    source: options.source ?? 'unknown',
    createdAt: Date.now(),
    ...(options.ttlMs ? { expiresAt: Date.now() + options.ttlMs } : {}),
  };
  if (persistent) {
    const grants = await loadPersistentMcpServerGrants();
    grants.push(grant);
    await savePersistentGrants();
  } else {
    sessionMcpServerGrants.push(grant);
  }
  auditPermissionGrant(grant);
  return grant;
}

function flattenSkillPermissions(permissions: SkillGrant['permissions']): string[] {
  return [
    ...permissions.filesystem.map((value) => `filesystem:${value}`),
    ...permissions.network.map((value) => `network:${value}`),
    ...permissions.commands.map((value) => `commands:${value}`),
    ...permissions.secrets.map((value) => `secrets:${value}`),
  ];
}

export async function grantSkillAccess(
  skillId: string,
  manifestDigest: string,
  permissions: SkillGrant['permissions'],
  options: { source?: string } = {},
): Promise<SkillGrant> {
  const normalizedSkillId = skillId.trim();
  if (!normalizedSkillId) throw new Error('Skill id must be a non-empty string');
  if (!manifestDigest.trim()) throw new Error('Skill manifest digest must be a non-empty string');

  const grants = await loadPersistentSkillGrants();
  const existing = grants.find((grant) => (
    isActive(grant)
    && grant.skillId === normalizedSkillId
    && grant.manifestDigest === manifestDigest
  ));
  if (existing) return existing;

  // manifest 变化后旧授权不能继续生效，避免技能升级后静默扩大能力。
  for (const grant of grants) {
    if (isActive(grant) && grant.skillId === normalizedSkillId) {
      grant.invalidatedAt = Date.now();
      auditPermissionInvalidate(grant);
    }
  }

  const normalizedPermissions: SkillGrant['permissions'] = {
    filesystem: [...new Set(permissions.filesystem)],
    network: [...new Set(permissions.network)],
    commands: [...new Set(permissions.commands)],
    secrets: [...new Set(permissions.secrets)],
  };
  const grant: SkillGrant = {
    id: crypto.randomUUID(),
    subject: 'skill',
    resourceType: 'skill',
    skillId: normalizedSkillId,
    manifestDigest,
    permissions: normalizedPermissions,
    capabilities: flattenSkillPermissions(normalizedPermissions),
    scope: 'persistent',
    source: options.source ?? 'unknown',
    createdAt: Date.now(),
  };
  grants.push(grant);
  await savePersistentGrants();
  auditPermissionGrant(grant);
  return grant;
}

function expandHome(inputPath: string): string {
  if (inputPath === '~') return homedir();
  return inputPath.replace(/^~(?=$|[\\/])/, homedir());
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveGrantPathInfo(filePath: string): Promise<{ absolutePath: string; realPath: string }> {
  const absolutePath = path.normalize(path.resolve(expandHome(filePath)));
  if (await pathExists(absolutePath)) {
    return { absolutePath, realPath: await realpath(absolutePath) };
  }
  // New files cannot be realpathed directly. Resolve the parent instead so a
  // write grant still inherits the parent's symlink-safe location.
  const parentRealPath = await realpath(path.dirname(absolutePath));
  return {
    absolutePath,
    realPath: path.join(parentRealPath, path.basename(absolutePath)),
  };
}

export async function grantDialogPaths(
  filePaths: string[],
  options: {
    directory?: boolean;
    source?: string;
  } = {},
): Promise<void> {
  // File picker selections are explicit user intent, so they become narrow
  // session grants. Directory selections are recursive; file selections are not.
  const capabilities: FileCapability[] = options.directory
    ? ['metadata', 'read', 'write', 'open']
    : ['metadata', 'read', 'stage', 'open'];
  for (const filePath of filePaths) {
    try {
      await grantPathAccess(filePath, {
        capabilities,
        recursive: options.directory ?? false,
        source: options.source ?? 'dialog',
      });
    } catch {
      // Ignore paths that disappear between dialog selection and grant creation.
    }
  }
}

export function listPathGrants(): PathGrant[] {
  const now = Date.now();
  return sessionPathGrants.filter((grant) => isActive(grant, now));
}

export function clearPathGrants(): void {
  sessionPathGrants.length = 0;
}

export async function listAllPathGrants(): Promise<PathGrant[]> {
  const now = Date.now();
  const persistent = await loadPersistentPathGrants();
  return [
    ...sessionPathGrants,
    ...persistent,
  ].filter((grant) => isActive(grant, now));
}

export async function listAllDomainGrants(): Promise<DomainGrant[]> {
  const now = Date.now();
  const persistent = await loadPersistentDomainGrants();
  return [
    ...sessionDomainGrants,
    ...persistent,
  ].filter((grant) => isActive(grant, now));
}

export async function listAllCommandGrants(): Promise<CommandGrant[]> {
  const now = Date.now();
  const persistent = await loadPersistentCommandGrants();
  return [
    ...sessionCommandGrants,
    ...persistent,
  ].filter((grant) => isActive(grant, now));
}

export async function listAllMcpServerGrants(): Promise<McpServerGrant[]> {
  const now = Date.now();
  const persistent = await loadPersistentMcpServerGrants();
  return [...sessionMcpServerGrants, ...persistent].filter((grant) => isActive(grant, now));
}

export async function listAllSkillGrants(): Promise<SkillGrant[]> {
  const grants = await loadPersistentSkillGrants();
  return grants.filter((grant) => isActive(grant));
}

export async function revokePathGrant(id: string): Promise<boolean> {
  const now = Date.now();
  const sessionGrant = sessionPathGrants.find((grant) => grant.id === id);
  if (sessionGrant) {
    sessionGrant.revokedAt = now;
    auditPermissionRevoke(sessionGrant);
    return true;
  }

  const persistent = await loadPersistentPathGrants();
  const persistentGrant = persistent.find((grant) => grant.id === id);
  if (!persistentGrant) return false;
  persistentGrant.revokedAt = now;
  await savePersistentGrants();
  auditPermissionRevoke(persistentGrant);
  return true;
}

export async function revokeDomainGrant(id: string): Promise<boolean> {
  const now = Date.now();
  const sessionGrant = sessionDomainGrants.find((grant) => grant.id === id);
  if (sessionGrant) {
    sessionGrant.revokedAt = now;
    auditPermissionRevoke(sessionGrant);
    return true;
  }

  const persistent = await loadPersistentDomainGrants();
  const persistentGrant = persistent.find((grant) => grant.id === id);
  if (!persistentGrant) return false;
  persistentGrant.revokedAt = now;
  await savePersistentGrants();
  auditPermissionRevoke(persistentGrant);
  return true;
}

export async function revokeCommandGrant(id: string): Promise<boolean> {
  const now = Date.now();
  const sessionGrant = sessionCommandGrants.find((grant) => grant.id === id);
  if (sessionGrant) {
    sessionGrant.revokedAt = now;
    auditPermissionRevoke(sessionGrant);
    return true;
  }

  const persistent = await loadPersistentCommandGrants();
  const persistentGrant = persistent.find((grant) => grant.id === id);
  if (!persistentGrant) return false;
  persistentGrant.revokedAt = now;
  await savePersistentGrants();
  auditPermissionRevoke(persistentGrant);
  return true;
}

export async function revokeMcpServerGrant(id: string): Promise<boolean> {
  const now = Date.now();
  const sessionGrant = sessionMcpServerGrants.find((grant) => grant.id === id);
  if (sessionGrant) {
    sessionGrant.revokedAt = now;
    auditPermissionRevoke(sessionGrant);
    return true;
  }
  const persistent = await loadPersistentMcpServerGrants();
  const persistentGrant = persistent.find((grant) => grant.id === id);
  if (!persistentGrant) return false;
  persistentGrant.revokedAt = now;
  await savePersistentGrants();
  auditPermissionRevoke(persistentGrant);
  return true;
}

export async function revokeSkillGrant(id: string): Promise<boolean> {
  const grants = await loadPersistentSkillGrants();
  const grant = grants.find((item) => item.id === id);
  if (!grant) return false;
  grant.revokedAt = Date.now();
  await savePersistentGrants();
  auditPermissionRevoke(grant);
  return true;
}

export async function revokeSkillGrantsForSkill(skillId: string): Promise<number> {
  const grants = await loadPersistentSkillGrants();
  let revoked = 0;
  for (const grant of grants) {
    if (isActive(grant) && grant.skillId === skillId) {
      grant.revokedAt = Date.now();
      auditPermissionRevoke(grant);
      revoked += 1;
    }
  }
  if (revoked > 0) await savePersistentGrants();
  return revoked;
}

export async function clearPersistentPathGrants(): Promise<void> {
  persistentPathGrants = [];
  await savePersistentGrants();
}

export async function clearPersistentDomainGrants(): Promise<void> {
  persistentDomainGrants = [];
  await savePersistentGrants();
}

export async function clearPersistentCommandGrants(): Promise<void> {
  persistentCommandGrants = [];
  await savePersistentGrants();
}

export function resetPermissionStoreForTests(): void {
  sessionPathGrants.length = 0;
  sessionDomainGrants.length = 0;
  sessionCommandGrants.length = 0;
  sessionMcpServerGrants.length = 0;
  persistentPathGrants = null;
  persistentDomainGrants = null;
  persistentCommandGrants = null;
  persistentMcpServerGrants = null;
  persistentSkillGrants = null;
}

export async function pruneExpiredPathGrants(): Promise<number> {
  const now = Date.now();
  const beforeSession = sessionPathGrants.length;
  for (let i = sessionPathGrants.length - 1; i >= 0; i -= 1) {
    if (!isActive(sessionPathGrants[i]!, now)) {
      sessionPathGrants.splice(i, 1);
    }
  }

  const persistent = await loadPersistentPathGrants();
  const beforePersistent = persistent.length;
  persistentPathGrants = persistent.filter((grant) => isActive(grant, now));
  if (persistentPathGrants.length !== beforePersistent) {
    await savePersistentGrants();
  }

  const beforeDomainSession = sessionDomainGrants.length;
  for (let i = sessionDomainGrants.length - 1; i >= 0; i -= 1) {
    if (!isActive(sessionDomainGrants[i]!, now)) {
      sessionDomainGrants.splice(i, 1);
    }
  }

  const persistentDomains = await loadPersistentDomainGrants();
  const beforePersistentDomains = persistentDomains.length;
  persistentDomainGrants = persistentDomains.filter((grant) => isActive(grant, now));
  if (persistentDomainGrants.length !== beforePersistentDomains) {
    await savePersistentGrants();
  }

  const beforeCommandSession = sessionCommandGrants.length;
  for (let i = sessionCommandGrants.length - 1; i >= 0; i -= 1) {
    if (!isActive(sessionCommandGrants[i]!, now)) {
      sessionCommandGrants.splice(i, 1);
    }
  }

  const persistentCommands = await loadPersistentCommandGrants();
  const beforePersistentCommands = persistentCommands.length;
  persistentCommandGrants = persistentCommands.filter((grant) => isActive(grant, now));
  if (persistentCommandGrants.length !== beforePersistentCommands) {
    await savePersistentGrants();
  }

  const beforeMcpServerSession = sessionMcpServerGrants.length;
  for (let i = sessionMcpServerGrants.length - 1; i >= 0; i -= 1) {
    if (!isActive(sessionMcpServerGrants[i]!, now)) {
      sessionMcpServerGrants.splice(i, 1);
    }
  }

  const persistentMcpServers = await loadPersistentMcpServerGrants();
  const beforePersistentMcpServers = persistentMcpServers.length;
  persistentMcpServerGrants = persistentMcpServers.filter((grant) => isActive(grant, now));
  if (persistentMcpServerGrants.length !== beforePersistentMcpServers) {
    await savePersistentGrants();
  }

  const persistentSkills = await loadPersistentSkillGrants();
  const beforePersistentSkills = persistentSkills.length;
  persistentSkillGrants = persistentSkills.filter((grant) => isActive(grant, now));
  if (persistentSkillGrants.length !== beforePersistentSkills) {
    await savePersistentGrants();
  }

  return (beforeSession - sessionPathGrants.length)
    + (beforePersistent - persistentPathGrants.length)
    + (beforeDomainSession - sessionDomainGrants.length)
    + (beforePersistentDomains - persistentDomainGrants.length)
    + (beforeCommandSession - sessionCommandGrants.length)
    + (beforePersistentCommands - persistentCommandGrants.length)
    + (beforeMcpServerSession - sessionMcpServerGrants.length)
    + (beforePersistentMcpServers - persistentMcpServerGrants.length)
    + (beforePersistentSkills - persistentSkillGrants.length);
}

export async function findPathGrant(realPath: string, capability: FileCapability): Promise<PathGrant | null> {
  const now = Date.now();
  const grants = await listAllPathGrants();
  for (const grant of grants) {
    if (!isActive(grant, now)) continue;
    if (!grant.capabilities.includes(capability)) continue;
    // Recursive grants cover descendants only after realpath normalization;
    // single-file grants require an exact realpath match.
    if (grant.recursive) {
      if (isPathInside(realPath, grant.realPath)) return grant;
    } else if (samePath(realPath, grant.realPath)) {
      return grant;
    }
  }
  return null;
}

export async function findDomainGrant(hostname: string, capability: NetworkCapability = 'connect'): Promise<DomainGrant | null> {
  const now = Date.now();
  const grants = await listAllDomainGrants();
  for (const grant of grants) {
    if (!isActive(grant, now)) continue;
    if (!grant.capabilities.includes(capability)) continue;
    // First active grant wins. Revoked/expired grants remain in persistent
    // storage until pruning so audit/debug history is not silently erased.
    if (domainMatches(hostname, grant.domain, grant.includeSubdomains)) return grant;
  }
  return null;
}

export async function findCommandGrant(input: {
  command: string;
  cwd?: string;
  source?: string;
  capability?: CommandCapability;
}): Promise<CommandGrant | null> {
  const now = Date.now();
  const capability = input.capability ?? 'execute';
  const fingerprint = buildCommandGrantFingerprint(input);
  const grants = await listAllCommandGrants();
  for (const grant of grants) {
    if (!isActive(grant, now)) continue;
    if (!grant.capabilities.includes(capability)) continue;
    if (grant.fingerprint === fingerprint) return grant;
  }
  return null;
}

export async function findMcpServerGrant(
  serverName: string,
  server: McpServerEntry,
  capability: McpServerCapability = 'enable',
): Promise<McpServerGrant | null> {
  const fingerprint = buildMcpServerFingerprint(serverName, server);
  const grants = await listAllMcpServerGrants();
  for (const grant of grants) {
    if (!grant.capabilities.includes(capability)) continue;
    if (grant.serverName === serverName && grant.fingerprint === fingerprint) return grant;
  }
  return null;
}

export async function findSkillGrant(skillId: string, manifestDigest: string): Promise<SkillGrant | null> {
  const grants = await listAllSkillGrants();
  return grants.find((grant) => grant.skillId === skillId && grant.manifestDigest === manifestDigest) ?? null;
}

function normalizeForCompare(filePath: string): string {
  const normalized = filePath.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function samePath(left: string, right: string): boolean {
  return normalizeForCompare(left) === normalizeForCompare(right);
}

export function isPathInside(filePath: string, rootPath: string): boolean {
  const candidate = normalizeForCompare(filePath);
  const root = normalizeForCompare(rootPath);
  if (candidate === root) return true;
  const separator = process.platform === 'win32' ? '\\' : '/';
  const normalizedRoot = root.endsWith(separator) ? root : `${root}${separator}`;
  return candidate.startsWith(normalizedRoot);
}
