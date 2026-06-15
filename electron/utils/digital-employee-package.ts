import { access, lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import type {
  DigitalEmployeeAgentTemplate,
  DigitalEmployeePackageManifest,
} from '../../shared/types/digital-employee';
import {
  checkCompressionRatio,
  checkNestingDepth,
  checkPathTraversal,
  checkSingleFileSize,
  checkSymlink,
  readZipEntries,
  validateExtractedSkill,
} from './skill-validator';
import { validateMcpConfig } from './mcp-config-validator';
import type { McpConfigFile } from './mcp-json';

const MANIFEST_FILE = 'employee.json';
const MAX_PACKAGE_FILES = 2_000;
export const MAX_DIGITAL_EMPLOYEE_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024;
const ALLOWED_TOP_LEVEL_ENTRIES = new Set([
  'employee.json',
  'README.md',
  'agent',
  'skills',
  'mcp',
  'resources',
  'workflows',
  'assets',
]);
const FORBIDDEN_NAMES = new Set([
  'auth-profiles.json',
  'models.json',
  'sessions.json',
  '.env',
]);
const FORBIDDEN_SEGMENTS = new Set(['sessions', 'memory']);

export interface ValidatedDigitalEmployeePackage {
  rootDir: string;
  manifest: DigitalEmployeePackageManifest;
  agentTemplate: DigitalEmployeeAgentTemplate | null;
  mcpConfig: McpConfigFile | null;
  skillDirectories: string[];
  warnings: string[];
}

function parseAgentTemplate(value: unknown): DigitalEmployeeAgentTemplate {
  if (!isRecord(value)) throw new Error('Agent template must contain an object');
  const template: DigitalEmployeeAgentTemplate = {};
  for (const field of ['id', 'name', 'workspace', 'agentDir', 'model'] as const) {
    if (value[field] === undefined) continue;
    template[field] = requireNonEmptyString(value[field], `agent template ${field}`);
  }
  if (template.id !== undefined && template.id !== '${AGENT_ID}') {
    throw new Error('Agent template id must use ${AGENT_ID}');
  }
  if (
    template.workspace !== undefined
    && template.workspace !== '~/.openclaw/workspace-${AGENT_ID}'
  ) {
    throw new Error('Agent template workspace must use the managed Agent workspace pattern');
  }
  if (
    template.agentDir !== undefined
    && template.agentDir !== '~/.openclaw/agents/${AGENT_ID}/agent'
  ) {
    throw new Error('Agent template agentDir must use the managed Agent runtime pattern');
  }
  if (template.model !== undefined && !template.model.includes('/')) {
    throw new Error('Agent template model must use provider/model format');
  }
  return template;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

export function validatePortableRelativePath(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} is required`);
  if (isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith('~')) {
    throw new Error(`${field} must be a portable relative path`);
  }
  const normalized = normalize(trimmed).replace(/\\/g, '/');
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error(`${field} must stay inside the package`);
  }
  return normalized.replace(/^\.\//, '');
}

function parseManifest(value: unknown): DigitalEmployeePackageManifest {
  if (!isRecord(value)) throw new Error('employee.json must contain an object');
  if (value.schemaVersion !== 1) throw new Error('Unsupported employee.json schemaVersion');
  if (!isRecord(value.package)) throw new Error('employee.json package is required');
  if (!isRecord(value.agent)) throw new Error('employee.json agent is required');

  requireNonEmptyString(value.package.id, 'package.id');
  requireNonEmptyString(value.package.name, 'package.name');
  requireNonEmptyString(value.package.version, 'package.version');
  requireNonEmptyString(value.package.description, 'package.description');
  validatePortableRelativePath(
    requireNonEmptyString(value.agent.workspaceSource, 'agent.workspaceSource'),
    'agent.workspaceSource',
  );

  if (value.agent.entryTemplate !== undefined) {
    validatePortableRelativePath(
      requireNonEmptyString(value.agent.entryTemplate, 'agent.entryTemplate'),
      'agent.entryTemplate',
    );
  }
  if (
    value.agent.modelRef !== undefined
    && value.agent.modelRef !== null
    && (
      typeof value.agent.modelRef !== 'string'
      || !value.agent.modelRef.trim()
      || !value.agent.modelRef.includes('/')
    )
  ) {
    throw new Error('agent.modelRef must use provider/model format or be null');
  }

  if (Array.isArray(value.skills)) {
    for (const [index, skill] of value.skills.entries()) {
      if (!isRecord(skill)) throw new Error(`skills[${index}] must be an object`);
      requireNonEmptyString(skill.slug, `skills[${index}].slug`);
      if (skill.source !== 'bundled' && skill.source !== 'dependency') {
        throw new Error(`skills[${index}].source is invalid`);
      }
      if (skill.source === 'bundled') {
        validatePortableRelativePath(
          requireNonEmptyString(skill.path, `skills[${index}].path`),
          `skills[${index}].path`,
        );
      }
    }
  }

  if (value.mcp !== undefined) {
    if (!isRecord(value.mcp)) throw new Error('mcp must be an object');
    validatePortableRelativePath(
      requireNonEmptyString(value.mcp.serverTemplate, 'mcp.serverTemplate'),
      'mcp.serverTemplate',
    );
  }

  if (value.execution !== undefined) {
    if (!isRecord(value.execution)) throw new Error('execution must be an object');
    if (value.execution.workflow !== undefined) {
      validatePortableRelativePath(
        requireNonEmptyString(value.execution.workflow, 'execution.workflow'),
        'execution.workflow',
      );
    }
  }

  if (value.resources !== undefined) {
    if (!Array.isArray(value.resources)) throw new Error('resources must be an array');
    for (const [index, resource] of value.resources.entries()) {
      if (!isRecord(resource)) throw new Error(`resources[${index}] must be an object`);
      requireNonEmptyString(resource.id, `resources[${index}].id`);
      if (resource.type !== 'file') throw new Error(`resources[${index}].type is invalid`);
      validatePortableRelativePath(
        requireNonEmptyString(resource.path, `resources[${index}].path`),
        `resources[${index}].path`,
      );
    }
  }

  if (value.install !== undefined) {
    if (!isRecord(value.install)) throw new Error('install must be an object');
    if (
      value.install.allowMultipleInstances !== undefined
      && typeof value.install.allowMultipleInstances !== 'boolean'
    ) {
      throw new Error('install.allowMultipleInstances must be a boolean');
    }
  }

  return value as unknown as DigitalEmployeePackageManifest;
}

function resolveInside(rootDir: string, portablePath: string): string {
  const resolvedRoot = resolve(rootDir);
  const target = resolve(resolvedRoot, portablePath);
  const rel = relative(resolvedRoot, target);
  if (!rel || rel === '.') return target;
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Package path escapes root: ${portablePath}`);
  }
  return target;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function validateDigitalEmployeeZip(zipPath: string): void {
  const entries = readZipEntries(zipPath);
  if (entries.length > MAX_PACKAGE_FILES) {
    throw new Error(`Digital employee package contains too many entries (${entries.length})`);
  }

  let totalBytes = 0;
  for (const entry of entries) {
    const errors = [
      checkPathTraversal(entry.entryName),
      checkCompressionRatio(entry),
      checkSingleFileSize(entry),
      checkNestingDepth(entry.entryName),
      checkSymlink(entry),
    ].filter((value): value is string => Boolean(value));
    if (errors.length > 0) {
      throw new Error(`Unsafe package entry "${entry.entryName}": ${errors.join('; ')}`);
    }
    if (!entry.isDirectory) totalBytes += entry.uncompressedSize;
  }

  if (totalBytes > MAX_DIGITAL_EMPLOYEE_UNCOMPRESSED_BYTES) {
    throw new Error('Digital employee package is too large after extraction');
  }
}

export async function resolveDigitalEmployeePackageRoot(extractDir: string): Promise<string> {
  if (await pathExists(join(extractDir, MANIFEST_FILE))) return extractDir;
  const entries = await readdir(extractDir, { withFileTypes: true });
  const visible = entries.filter((entry) => !entry.name.startsWith('.'));
  if (visible.length !== 1 || !visible[0].isDirectory()) {
    throw new Error('employee.json must be at the ZIP root or inside one top-level directory');
  }
  const nestedRoot = join(extractDir, visible[0].name);
  if (!(await pathExists(join(nestedRoot, MANIFEST_FILE)))) {
    throw new Error('employee.json not found in digital employee package');
  }
  return nestedRoot;
}

async function validateExtractedTree(rootDir: string): Promise<void> {
  const realRoot = await realpath(rootDir);

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const stat = await lstat(fullPath);
      if (stat.isSymbolicLink()) throw new Error(`Symbolic links are not allowed: ${fullPath}`);
      const entryRealPath = await realpath(fullPath);
      const rel = relative(realRoot, entryRealPath);
      if (rel.startsWith('..') || isAbsolute(rel)) {
        throw new Error(`Package entry escapes root: ${fullPath}`);
      }

      const relativePath = relative(realRoot, fullPath);
      const segments = relativePath.split(sep).filter(Boolean);
      const lowerName = entry.name.toLowerCase();
      if (FORBIDDEN_NAMES.has(lowerName) || segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment.toLowerCase()))) {
        throw new Error(`Runtime or sensitive file is not allowed in employee package: ${relativePath}`);
      }
      if (entry.isDirectory()) await walk(fullPath);
    }
  }

  await walk(rootDir);
}

export async function validateExtractedDigitalEmployeePackage(
  extractDir: string,
): Promise<ValidatedDigitalEmployeePackage> {
  const rootDir = await resolveDigitalEmployeePackageRoot(extractDir);
  await validateExtractedTree(rootDir);

  const topLevelEntries = await readdir(rootDir, { withFileTypes: true });
  for (const entry of topLevelEntries) {
    if (!ALLOWED_TOP_LEVEL_ENTRIES.has(entry.name)) {
      throw new Error(`Unsupported top-level package entry: ${entry.name}`);
    }
  }

  const manifestRaw = await readFile(join(rootDir, MANIFEST_FILE), 'utf8');
  const manifest = parseManifest(JSON.parse(manifestRaw) as unknown);
  const workspaceDir = resolveInside(rootDir, manifest.agent.workspaceSource);
  if (!(await pathExists(workspaceDir)) || !(await stat(workspaceDir)).isDirectory()) {
    throw new Error('Agent workspace source must be an existing directory');
  }

  let agentTemplate: DigitalEmployeeAgentTemplate | null = null;
  if (manifest.agent.entryTemplate) {
    const templatePath = resolveInside(
      rootDir,
      validatePortableRelativePath(manifest.agent.entryTemplate, 'agent.entryTemplate'),
    );
    agentTemplate = parseAgentTemplate(
      JSON.parse(await readFile(templatePath, 'utf8')) as unknown,
    );
  }

  if (manifest.execution?.workflow) {
    const workflowPath = resolveInside(
      rootDir,
      validatePortableRelativePath(manifest.execution.workflow, 'execution.workflow'),
    );
    if (!(await pathExists(workflowPath))) throw new Error('Execution workflow does not exist');
  }

  for (const [index, resource] of (manifest.resources ?? []).entries()) {
    const resourcePath = resolveInside(
      rootDir,
      validatePortableRelativePath(resource.path, `resources[${index}].path`),
    );
    if (!(await pathExists(resourcePath)) || !(await stat(resourcePath)).isFile()) {
      throw new Error(`Resource "${resource.id}" must be an existing file`);
    }
  }

  const skillDirectories: string[] = [];
  const warnings: string[] = [];
  for (const skill of manifest.skills ?? []) {
    if (skill.source !== 'bundled' || !skill.path) continue;
    const skillDir = resolveInside(rootDir, validatePortableRelativePath(skill.path, `skill ${skill.slug}`));
    const result = validateExtractedSkill(skillDir);
    if (!result.allowed) {
      throw new Error(`Skill "${skill.slug}" failed validation: ${result.blockReason ?? 'invalid skill'}`);
    }
    if (result.summary.warnings > 0) {
      warnings.push(`Skill "${skill.slug}" has ${result.summary.warnings} warning(s)`);
    }
    skillDirectories.push(skillDir);
  }

  let mcpConfig: McpConfigFile | null = null;
  if (manifest.mcp) {
    const mcpPath = resolveInside(
      rootDir,
      validatePortableRelativePath(manifest.mcp.serverTemplate, 'mcp.serverTemplate'),
    );
    mcpConfig = JSON.parse(await readFile(mcpPath, 'utf8')) as McpConfigFile;
    const validation = validateMcpConfig(mcpConfig);
    if (!validation.valid) {
      throw new Error(`MCP configuration is invalid: ${validation.errors.join('; ')}`);
    }
    const configuredServers = new Set(Object.keys(mcpConfig.servers));
    for (const binding of manifest.mcp.bindings ?? []) {
      if (!configuredServers.has(binding.server)) {
        throw new Error(`MCP binding references missing server: ${binding.server}`);
      }
    }
  }

  return { rootDir, manifest, agentTemplate, mcpConfig, skillDirectories, warnings };
}
