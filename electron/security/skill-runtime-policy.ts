import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { auditSecurityEvent } from './audit-log';
import { commandToString, evaluateCommandPolicy } from './command-policy';
import { evaluateNetworkPolicy } from './network-policy';
import { evaluatePathPolicy } from './path-policy';
import { findSkillGrant } from './permission-store';
import { applyCurrentSecurityModeToDecision } from './security-mode';
import { getOpenClawSkillsDir } from '../utils/paths';
import type {
  CommandPolicyRequest,
  CommandPolicyResult,
  FileCapability,
  NetworkPolicyRequest,
  NetworkPolicyResult,
  PathPolicyRequest,
  PathPolicyResult,
  SecurityDecision,
  SkillGrant,
  SkillRuntimeSecurityContext,
} from './types';

export type SkillRuntimeCapabilityRequest =
  | {
      kind: 'file';
      context: SkillRuntimeSecurityContext;
      path: string;
      capability: FileCapability;
      baseDir?: string;
      allowedRoots?: string[];
    }
  | {
      kind: 'network';
      context: SkillRuntimeSecurityContext;
      url: string;
      request?: Omit<NetworkPolicyRequest, 'url' | 'source' | 'allowedDomains'>;
    }
  | {
      kind: 'command';
      context: SkillRuntimeSecurityContext;
      command?: string;
      executable?: string;
      args?: string[];
      cwd?: string;
      allowedRoots?: string[];
    };

export interface SkillRuntimePolicyResult {
  decision: SecurityDecision;
  grant?: SkillGrant;
  legacyLocalSkill?: boolean;
  delegatedResult?: PathPolicyResult | NetworkPolicyResult | CommandPolicyResult;
}

function allow(reasons: string[]): SecurityDecision {
  return { action: 'allow', risk: 'low', reasons };
}

function deny(code: string, reasons: string[]): SecurityDecision {
  return { action: 'deny', risk: 'high', reasons, code };
}

function sourceForContext(context: SkillRuntimeSecurityContext): string {
  return context.source?.trim() || `skill-runtime:${context.skillId}`;
}

function domainMatches(hostname: string, declaredDomain: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  const declared = declaredDomain.toLowerCase().replace(/\.$/, '');
  if (declared.startsWith('*.')) {
    const suffix = declared.slice(2);
    return host !== suffix && host.endsWith(`.${suffix}`);
  }
  return host === declared || host.endsWith(`.${declared}`);
}

function requiredFilesystemPermission(capability: FileCapability): string {
  switch (capability) {
    case 'metadata':
      return 'workspace:metadata';
    case 'read':
    case 'stage':
    case 'open':
      return 'workspace:read';
    case 'write':
      return 'workspace:write';
    case 'delete':
      return 'workspace:delete';
    case 'execute':
      return 'workspace:execute';
    default: {
      const exhaustive: never = capability;
      return exhaustive;
    }
  }
}

function firstExecutable(segment: string): string | null {
  const trimmed = segment.trim().replace(/^[()]+/, '');
  const match = /^(?:"([^"]+)"|'([^']+)'|([^\s]+))/.exec(trimmed);
  const executable = match?.[1] ?? match?.[2] ?? match?.[3];
  return executable ? path.basename(executable).toLowerCase() : null;
}

function commandExecutables(request: Pick<CommandPolicyRequest, 'command' | 'executable' | 'args'>): string[] {
  const command = commandToString(request);
  return [...new Set(
    command
      .split(/&&|\|\||[|;]/)
      .map(firstExecutable)
      .filter((value): value is string => Boolean(value)),
  )];
}

function targetForRequest(request: SkillRuntimeCapabilityRequest): string {
  if (request.kind === 'file') return request.path;
  if (request.kind === 'network') return request.url;
  return commandToString(request);
}

function operationForRequest(request: SkillRuntimeCapabilityRequest): string {
  if (request.kind === 'file') return `file:${request.capability}`;
  if (request.kind === 'network') return 'network:connect';
  return 'command:execute';
}

function auditRuntimeDecision(
  request: SkillRuntimeCapabilityRequest,
  decision: SecurityDecision,
  stage: 'declaration' | 'delegated-policy' = 'declaration',
): void {
  auditSecurityEvent({
    source: sourceForContext(request.context),
    subject: `skill:${request.context.skillId}`,
    capability: 'skill-runtime',
    operation: operationForRequest(request),
    target: targetForRequest(request),
    decision: decision.action,
    risk: decision.risk,
    reasons: decision.reasons,
    code: decision.action === 'deny' ? decision.code : undefined,
    metadata: {
      skillId: request.context.skillId,
      manifestDigest: request.context.manifestDigest,
      capabilityKind: request.kind,
      stage,
    },
  });
}

async function loadBoundGrant(context: SkillRuntimeSecurityContext): Promise<SkillGrant | null> {
  if (!context.skillId.trim() || !context.manifestDigest.trim()) return null;
  return await findSkillGrant(context.skillId.trim(), context.manifestDigest.trim());
}

function getLegacySkillsRoot(): string {
  return process.env.CLAWX_LEGACY_SKILLS_ROOT || getOpenClawSkillsDir();
}

/**
 * 已声明权限的 Skill 在自己的 skill 目录（~/.openclaw/skills/<id>/）里运行脚本属于正常工作区，
 * 把它作为授权根传给命令策略，避免 cwd 被判为 workspace 越权。仍是最小授权：只放行该 Skill
 * 自己的目录，不影响敏感路径、私网阻断或危险命令判断。
 */
function skillOwnRoots(context: SkillRuntimeSecurityContext): string[] {
  const skillId = context.skillId.trim();
  if (!skillId) return [];
  return [...new Set([
    path.join(getOpenClawSkillsDir(), skillId),
    path.join(getLegacySkillsRoot(), skillId),
  ])];
}

async function isMatchingLegacyLocalSkill(context: SkillRuntimeSecurityContext): Promise<boolean> {
  const skillId = context.skillId.trim();
  const manifestDigest = context.manifestDigest.trim();
  if (!skillId || !manifestDigest) return false;

  try {
    const manifest = await readFile(path.join(getLegacySkillsRoot(), skillId, 'SKILL.md'));
    const actualDigest = crypto.createHash('sha256').update(manifest).digest('hex');
    return actualDigest === manifestDigest;
  } catch {
    return false;
  }
}

/**
 * 先校验 Skill 安装时确认过的权限，再交给文件、网络和命令策略继续判断。
 * Skill grant 只能缩小权限范围，不能绕过敏感路径、私网阻断或危险命令规则。
 */
export async function evaluateSkillRuntimeDeclaration(
  request: SkillRuntimeCapabilityRequest,
): Promise<SkillRuntimePolicyResult> {
  const grant = await loadBoundGrant(request.context);
  if (!grant) {
    // 兼容历史已安装 Skill：安全授权中心上线前安装的 Skill 没有 SkillGrant。
    // 只有本地 SKILL.md 的摘要和 Runtime 上报的 manifestDigest 完全一致时，
    // 才允许进入后续文件/网络/命令策略；这不会绕过敏感路径、私网阻断或危险命令判断。
    if (await isMatchingLegacyLocalSkill(request.context)) {
      const decision = allow([
        `Legacy local Skill ${request.context.skillId} matched its local manifest; delegated security policies still apply`,
      ]);
      auditRuntimeDecision(request, decision);
      return { decision, legacyLocalSkill: true };
    }

    const decision = deny('SKILL_RUNTIME_GRANT_REQUIRED', [
      `Skill ${request.context.skillId || '<unknown>'} has no active grant for this manifest`,
    ]);
    auditRuntimeDecision(request, decision);
    return { decision };
  }

  let decision: SecurityDecision;
  if (request.kind === 'file') {
    const required = requiredFilesystemPermission(request.capability);
    decision = grant.permissions.filesystem.includes(required)
      ? allow([`Skill ${grant.skillId} declared ${required}`])
      : deny('SKILL_FILESYSTEM_PERMISSION_NOT_DECLARED', [`Skill ${grant.skillId} did not declare ${required}`]);
  } else if (request.kind === 'network') {
    let hostname = '';
    try {
      hostname = new URL(request.url).hostname;
    } catch {
      // URL 格式错误仍交给网络策略处理，但声明层不能提前放行。
    }
    decision = hostname && grant.permissions.network.some((domain) => domainMatches(hostname, domain))
      ? allow([`Skill ${grant.skillId} declared network access to ${hostname}`])
      : deny('SKILL_NETWORK_PERMISSION_NOT_DECLARED', [`Skill ${grant.skillId} did not declare network access to ${hostname || request.url}`]);
  } else {
    const declared = new Set(grant.permissions.commands.map((command) => command.toLowerCase()));
    const executables = commandExecutables(request);
    const declaredExecutables = executables.filter((executable) => declared.has(executable));
    const undeclaredExecutables = executables.filter((executable) => !declared.has(executable));
    // 第一版采用黑名单/危险行为拦截：已授权 Skill 的命令不再因为 launcher 未声明而硬拒绝。
    // 删除、提权、下载后执行、敏感路径等真实风险仍由后续 command-policy 统一判断。
    decision = allow([
      `Skill ${grant.skillId} command execution is delegated to command policy`,
      ...(declaredExecutables.length > 0 ? [`Declared launchers: ${declaredExecutables.join(', ')}`] : []),
      ...(undeclaredExecutables.length > 0 ? [`Undeclared launchers allowed for policy evaluation: ${undeclaredExecutables.join(', ')}`] : []),
    ]);
  }

  auditRuntimeDecision(request, decision);
  return { decision, grant };
}

function runtimeError(result: SkillRuntimePolicyResult): Error & { code?: string; decision?: SecurityDecision } {
  const error = new Error(result.decision.reasons.join('; ')) as Error & {
    code?: string;
    decision?: SecurityDecision;
  };
  error.code = result.decision.action === 'deny' ? result.decision.code : 'SKILL_RUNTIME_REQUIRES_CONFIRMATION';
  error.decision = result.decision;
  return error;
}

export async function assertSkillRuntimeCapabilityDeclared(request: SkillRuntimeCapabilityRequest): Promise<SkillGrant> {
  const result = await evaluateSkillRuntimeDeclaration(request);
  if (result.decision.action !== 'allow' || !result.grant) throw runtimeError(result);
  return result.grant;
}

export async function evaluateSkillRuntimeFilePolicy(
  request: Extract<SkillRuntimeCapabilityRequest, { kind: 'file' }>,
): Promise<SkillRuntimePolicyResult> {
  const declared = await evaluateSkillRuntimeDeclaration(request);
  if (declared.decision.action !== 'allow') return declared;
  const delegatedResult = await evaluatePathPolicy({
    path: request.path,
    capability: request.capability,
    source: sourceForContext(request.context),
    baseDir: request.baseDir,
    allowedRoots: request.allowedRoots,
  });
  auditRuntimeDecision(request, delegatedResult.decision, 'delegated-policy');
  return {
    decision: delegatedResult.decision,
    grant: declared.grant,
    legacyLocalSkill: declared.legacyLocalSkill,
    delegatedResult,
  };
}

export async function evaluateSkillRuntimeNetworkPolicy(
  request: Extract<SkillRuntimeCapabilityRequest, { kind: 'network' }>,
): Promise<SkillRuntimePolicyResult> {
  const declared = await evaluateSkillRuntimeDeclaration(request);
  if (declared.decision.action !== 'allow') return declared;
  const delegatedResult = await evaluateNetworkPolicy({
    ...request.request,
    url: request.url,
    source: sourceForContext(request.context),
    allowedDomains: declared.grant?.permissions.network,
  });
  auditRuntimeDecision(request, delegatedResult.decision, 'delegated-policy');
  return {
    decision: delegatedResult.decision,
    grant: declared.grant,
    legacyLocalSkill: declared.legacyLocalSkill,
    delegatedResult,
  };
}

export async function evaluateSkillRuntimeCommandPolicy(
  request: Extract<SkillRuntimeCapabilityRequest, { kind: 'command' }>,
): Promise<SkillRuntimePolicyResult> {
  const declared = await evaluateSkillRuntimeDeclaration(request);
  if (declared.decision.action !== 'allow') return declared;
  const rawDelegatedResult = await evaluateCommandPolicy({
    command: request.command,
    executable: request.executable,
    args: request.args,
    cwd: request.cwd,
    allowedRoots: [...(request.allowedRoots ?? []), ...skillOwnRoots(request.context)],
    source: sourceForContext(request.context),
  });
  const delegatedResult = allowDeclaredSkillRoutineCommandPrompts(rawDelegatedResult, request.context.skillId);
  auditRuntimeDecision(request, delegatedResult.decision, 'delegated-policy');
  return {
    decision: delegatedResult.decision,
    grant: declared.grant,
    legacyLocalSkill: declared.legacyLocalSkill,
    delegatedResult,
  };
}

function allowDeclaredSkillRoutineCommandPrompts(
  result: CommandPolicyResult,
  skillId: string,
): CommandPolicyResult {
  if (result.decision.action !== 'prompt') return result;
  const promptSegments = result.segments.filter((segment) => segment.action === 'prompt');
  if (promptSegments.length === 0) return result;
  const allowedPromptRules = new Set([
    'command-path-write',
    'repair-command',
    'package-manager-change',
    'python-package-change',
    'git-state-change',
  ]);
  const allPromptsAreRoutine = promptSegments.every((segment) =>
    segment.risk !== 'high'
    && segment.risk !== 'critical'
    && segment.matchedRules.every((rule) => allowedPromptRules.has(rule) || rule === 'low-risk-default'),
  );
  if (!allPromptsAreRoutine) return result;

  // 已授权 Skill 的常规项目写入/初始化命令不再打断用户；危险规则仍保持 prompt/deny。
  return {
    ...result,
    decision: {
      action: 'allow',
      risk: result.decision.risk,
      reasons: [
        `Routine command prompts were auto-allowed for declared Skill ${skillId}`,
        ...result.decision.reasons,
      ],
    },
  };
}

async function assertRuntimeAllowed<T extends SkillRuntimePolicyResult>(result: T): Promise<T> {
  const effective = {
    ...result,
    decision: await applyCurrentSecurityModeToDecision(result.decision),
  };
  if (effective.decision.action !== 'allow') throw runtimeError(effective);
  return effective;
}

export async function assertSkillRuntimeFileAllowed(
  request: Extract<SkillRuntimeCapabilityRequest, { kind: 'file' }>,
): Promise<SkillRuntimePolicyResult> {
  return await assertRuntimeAllowed(await evaluateSkillRuntimeFilePolicy(request));
}

export async function assertSkillRuntimeNetworkAllowed(
  request: Extract<SkillRuntimeCapabilityRequest, { kind: 'network' }>,
): Promise<SkillRuntimePolicyResult> {
  return await assertRuntimeAllowed(await evaluateSkillRuntimeNetworkPolicy(request));
}

export async function assertSkillRuntimeCommandAllowed(
  request: Extract<SkillRuntimeCapabilityRequest, { kind: 'command' }>,
): Promise<SkillRuntimePolicyResult> {
  return await assertRuntimeAllowed(await evaluateSkillRuntimeCommandPolicy(request));
}
