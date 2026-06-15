import type { SecurityDecision, SecurityRisk } from './types';

export type SkillPermissionSubject = 'skill' | 'plugin';
export type SkillFilesystemPermission =
  | 'workspace:metadata'
  | 'workspace:read'
  | 'workspace:write'
  | 'workspace:delete'
  | 'workspace:execute';

export interface SkillManifestPermissions {
  filesystem: SkillFilesystemPermission[];
  network: string[];
  commands: string[];
  secrets: string[];
}

export interface SkillPermissionFinding {
  level: 'error' | 'warning';
  field: keyof SkillManifestPermissions | 'permissions';
  message: string;
}

export interface SkillPermissionPolicyResult {
  subject: SkillPermissionSubject;
  declared: boolean;
  permissions: SkillManifestPermissions;
  findings: SkillPermissionFinding[];
  decision: SecurityDecision;
}

export interface SkillManifestPermissionDiff {
  added: string[];
  unchanged: string[];
  removed: string[];
}

const ALLOWED_FILESYSTEM_PERMISSIONS = new Set<SkillFilesystemPermission>([
  'workspace:metadata',
  'workspace:read',
  'workspace:write',
  'workspace:delete',
  'workspace:execute',
]);

const ALLOWED_PERMISSION_KEYS = new Set<keyof SkillManifestPermissions>([
  'filesystem',
  'network',
  'commands',
  'secrets',
]);

/**
 * Skill 始终运行在用户已授权的 Workspace 边界内。
 * 常规文件信息、读取和写入属于基础能力；敏感路径与 Workspace 外路径仍由路径策略中心拦截。
 */
export const DEFAULT_SKILL_WORKSPACE_PERMISSIONS: readonly SkillFilesystemPermission[] = [
  'workspace:metadata',
  'workspace:read',
  'workspace:write',
];

const COMMAND_NAME_PATTERN = /^[a-z0-9][a-z0-9._+-]*$/i;
const DOMAIN_PATTERN = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function cloneEmptyPermissions(): SkillManifestPermissions {
  return {
    filesystem: [],
    network: [],
    commands: [],
    secrets: [],
  };
}

function cloneDefaultPermissions(subject: SkillPermissionSubject): SkillManifestPermissions {
  const permissions = cloneEmptyPermissions();
  if (subject === 'skill') {
    permissions.filesystem = [...DEFAULT_SKILL_WORKSPACE_PERMISSIONS];
  }
  return permissions;
}

function denyDecision(findings: SkillPermissionFinding[]): SecurityDecision {
  return {
    action: 'deny',
    risk: 'high',
    reasons: uniqueStrings(findings.filter((finding) => finding.level === 'error').map((finding) => finding.message)),
    code: 'MANIFEST_PERMISSION_DECLARATION_INVALID',
  };
}

function allowDecision(findings: SkillPermissionFinding[], risk: SecurityRisk): SecurityDecision {
  return {
    action: 'allow',
    risk,
    reasons: findings.length > 0
      ? uniqueStrings(findings.map((finding) => finding.message))
      : ['Manifest permissions are valid and follow the Workspace-scoped capability schema'],
  };
}

function normalizeStringArray(
  field: keyof SkillManifestPermissions,
  value: unknown,
  findings: SkillPermissionFinding[],
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    findings.push({
      level: 'error',
      field,
      message: `permissions.${field} must be an array of strings`,
    });
    return [];
  }

  const normalized: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      findings.push({
        level: 'error',
        field,
        message: `permissions.${field} contains a non-string or empty value`,
      });
      continue;
    }
    normalized.push(item.trim());
  }
  return uniqueStrings(normalized);
}

function validateFilesystemPermissions(
  permissions: string[],
  findings: SkillPermissionFinding[],
): SkillFilesystemPermission[] {
  const valid: SkillFilesystemPermission[] = [];
  for (const permission of permissions) {
    if (permission === '*' || permission.startsWith('host:') || permission.startsWith('system:')) {
      findings.push({
        level: 'error',
        field: 'filesystem',
        message: `permissions.filesystem cannot request unrestricted host access: "${permission}"`,
      });
      continue;
    }
    if (!ALLOWED_FILESYSTEM_PERMISSIONS.has(permission as SkillFilesystemPermission)) {
      findings.push({
        level: 'error',
        field: 'filesystem',
        message: `permissions.filesystem contains unsupported capability: "${permission}"`,
      });
      continue;
    }
    valid.push(permission as SkillFilesystemPermission);
  }
  return valid;
}

function validateNetworkPermissions(permissions: string[], findings: SkillPermissionFinding[]): string[] {
  const valid: string[] = [];
  for (const permission of permissions) {
    const normalized = permission.toLowerCase().replace(/\.$/, '');
    if (normalized === '*' || normalized === '*.*') {
      findings.push({
        level: 'error',
        field: 'network',
        message: 'permissions.network cannot grant unrestricted network access',
      });
      continue;
    }
    if (!DOMAIN_PATTERN.test(normalized)) {
      findings.push({
        level: 'error',
        field: 'network',
        message: `permissions.network must contain domain names only: "${permission}"`,
      });
      continue;
    }
    valid.push(normalized);
  }
  return uniqueStrings(valid);
}

function validateCommandPermissions(permissions: string[], findings: SkillPermissionFinding[]): string[] {
  const valid: string[] = [];
  for (const permission of permissions) {
    const normalized = permission.toLowerCase();
    if (normalized === '*' || normalized === 'shell' || normalized === 'cmd' || normalized === 'powershell'
      || normalized === 'bash' || normalized === 'sh') {
      findings.push({
        level: 'error',
        field: 'commands',
        message: `permissions.commands cannot request an unrestricted shell launcher: "${permission}"`,
      });
      continue;
    }
    if (!COMMAND_NAME_PATTERN.test(permission)) {
      findings.push({
        level: 'error',
        field: 'commands',
        message: `permissions.commands must contain executable basenames only: "${permission}"`,
      });
      continue;
    }
    valid.push(permission);
  }
  return uniqueStrings(valid);
}

function validateSecretPermissions(permissions: string[], findings: SkillPermissionFinding[]): string[] {
  if (permissions.length === 0) return [];
  for (const permission of permissions) {
    findings.push({
      level: 'error',
      field: 'secrets',
      message: `permissions.secrets is reserved and cannot be granted to ${permission === '*' ? 'any secret' : `"${permission}"`}`,
    });
  }
  return [];
}

/**
 * 校验 Skill 或插件声明的权限。当前只建立“权限说明书”：
 * 运行期是否真正放行，仍必须由 Main 进程里的文件、网络和命令策略决定。
 */
export function evaluateSkillManifestPermissions(
  value: unknown,
  subject: SkillPermissionSubject = 'skill',
): SkillPermissionPolicyResult {
  const findings: SkillPermissionFinding[] = [];
  if (value === undefined || value === null) {
    return {
      subject,
      declared: false,
      permissions: cloneDefaultPermissions(subject),
      findings,
      decision: allowDecision(findings, 'low'),
    };
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    findings.push({
      level: 'error',
      field: 'permissions',
      message: 'permissions must be an object',
    });
    return {
      subject,
      declared: true,
      permissions: cloneDefaultPermissions(subject),
      findings,
      decision: denyDecision(findings),
    };
  }

  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (key === '__parseError') {
      const parseErrors = Array.isArray(raw[key]) ? raw[key] as unknown[] : [];
      findings.push({
        level: 'error',
        field: 'permissions',
        message: typeof parseErrors[0] === 'string' ? parseErrors[0] : 'permissions contains unsupported syntax',
      });
      continue;
    }
    if (!ALLOWED_PERMISSION_KEYS.has(key as keyof SkillManifestPermissions)) {
      findings.push({
        level: 'error',
        field: 'permissions',
        message: `permissions contains unsupported field: "${key}"`,
      });
    }
  }

  const declaredFilesystem = validateFilesystemPermissions(normalizeStringArray('filesystem', raw.filesystem, findings), findings);
  const permissions: SkillManifestPermissions = {
    filesystem: uniqueStrings([
      ...cloneDefaultPermissions(subject).filesystem,
      ...declaredFilesystem,
    ]) as SkillFilesystemPermission[],
    network: validateNetworkPermissions(normalizeStringArray('network', raw.network, findings), findings),
    commands: validateCommandPermissions(normalizeStringArray('commands', raw.commands, findings), findings),
    secrets: validateSecretPermissions(normalizeStringArray('secrets', raw.secrets, findings), findings),
  };

  const hasErrors = findings.some((finding) => finding.level === 'error');
  const hasElevatedCapabilities = permissions.filesystem.some((permission) => (
    permission === 'workspace:delete' || permission === 'workspace:execute'
  )) || permissions.commands.length > 0 || permissions.network.length > 0;

  return {
    subject,
    declared: true,
    permissions,
    findings,
    decision: hasErrors ? denyDecision(findings) : allowDecision(findings, hasElevatedCapabilities ? 'medium' : 'low'),
  };
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseInlineArray(value: string): string[] | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(',').map(unquote);
}

/**
 * SKILL.md 使用 YAML frontmatter。这里仅解析 permissions 下的简单列表，
 * 有意不支持复杂 YAML 特性，避免声明格式在不同入口出现不一致解释。
 */
export function parseSkillPermissionsFromFrontmatter(frontmatter: string): unknown {
  const lines = frontmatter.replace(/\r\n/g, '\n').split('\n');
  const permissionsIndex = lines.findIndex((line) => /^permissions\s*:\s*(?:#.*)?$/.test(line.trim()));
  if (permissionsIndex < 0) return undefined;

  const result: Record<string, unknown> = {};
  let currentField: string | null = null;
  for (let index = permissionsIndex + 1; index < lines.length; index += 1) {
    const rawLine = lines[index];
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) continue;

    const indent = rawLine.length - rawLine.trimStart().length;
    if (indent === 0) break;

    const fieldMatch = rawLine.match(/^\s{2,}([a-zA-Z][\w-]*)\s*:\s*(.*?)\s*$/);
    if (fieldMatch) {
      currentField = fieldMatch[1];
      const inline = parseInlineArray(fieldMatch[2]);
      if (fieldMatch[2].trim().length > 0 && inline === null) {
        result.__parseError = [`permissions.${currentField} must use a YAML list or an inline array`];
      }
      result[currentField] = inline ?? [];
      continue;
    }

    const itemMatch = rawLine.match(/^\s{4,}-\s*(.+?)\s*$/);
    if (itemMatch && currentField) {
      const list = Array.isArray(result[currentField]) ? result[currentField] as unknown[] : [];
      list.push(unquote(itemMatch[1]));
      result[currentField] = list;
      continue;
    }

    result.__parseError = [`Unsupported permissions syntax near: ${rawLine.trim()}`];
  }
  return result;
}

export function evaluateSkillFrontmatterPermissions(frontmatter: string): SkillPermissionPolicyResult {
  return evaluateSkillManifestPermissions(parseSkillPermissionsFromFrontmatter(frontmatter), 'skill');
}

function flattenPermissions(permissions: SkillManifestPermissions): string[] {
  return [
    ...permissions.filesystem.map((value) => `filesystem:${value}`),
    ...permissions.network.map((value) => `network:${value}`),
    ...permissions.commands.map((value) => `commands:${value}`),
    ...permissions.secrets.map((value) => `secrets:${value}`),
  ];
}

/**
 * 权限 diff 使用稳定的 category:value 形式，Renderer 只负责翻译和展示。
 * 后续插件升级确认也可以直接复用同一份结果。
 */
export function diffSkillManifestPermissions(
  previous: SkillManifestPermissions | undefined,
  next: SkillManifestPermissions,
): SkillManifestPermissionDiff {
  const previousSet = new Set(flattenPermissions(previous ?? cloneDefaultPermissions('skill')));
  const nextSet = new Set(flattenPermissions(next));
  return {
    added: [...nextSet].filter((value) => !previousSet.has(value)),
    unchanged: [...nextSet].filter((value) => previousSet.has(value)),
    removed: [...previousSet].filter((value) => !nextSet.has(value)),
  };
}

/**
 * Workspace 基础权限来自用户已经授权的工作区，不需要在安装普通 Skill 时重复确认。
 * 只有 manifest 新增了额外能力，才要求用户在安装前进行二次确认。
 */
export function requiresSkillPermissionConfirmation(diff: SkillManifestPermissionDiff): boolean {
  return diff.added.length > 0;
}
