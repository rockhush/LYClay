import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { assertCommandAllowedWithConfirmation } from '../security/confirmation-service';
import { assertSkillRuntimeCommandAllowed } from '../security/skill-runtime-policy';
import type {
  CommandPolicyRequest,
  CommandPolicyResult,
  SkillRuntimeSecurityContext,
} from '../security/types';
import { logger } from '../utils/logger';
import { getOpenClawSkillsDir } from '../utils/paths';

type GatewayRequest = (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>;

export interface GatewayExecApprovalBridgeDeps {
  request: GatewayRequest;
  approveCommand?: (request: CommandPolicyRequest) => Promise<CommandPolicyResult>;
  approveSkillCommand?: (input: {
    context: SkillRuntimeSecurityContext;
    command: string;
    cwd?: string;
  }) => Promise<unknown>;
}

interface ExecApprovalRequest {
  id: string;
  command?: string;
  cwd?: string;
  sessionKey?: string;
  agentId?: string;
  host?: string;
  skillId?: string;
  manifestDigest?: string;
}

interface InferredSkillContext {
  skillId: string;
  manifestDigest: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function extractRequestPayload(payload: unknown): ExecApprovalRequest | null {
  const record = asRecord(payload);
  if (!record) return null;

  const id = readString(record.id) ?? readString(record.approvalId);
  const request = asRecord(record.request) ?? record;
  const securityContext = asRecord(request.securityContext);
  if (!id) return null;

  return {
    id,
    command: readString(request.command)
      ?? readString(request.commandText)
      ?? readString(request.commandPreview),
    cwd: readString(request.cwd),
    sessionKey: readString(request.sessionKey),
    agentId: readString(request.agentId),
    host: readString(request.host),
    skillId: readString(securityContext?.skillId) ?? readString(request.skillId),
    manifestDigest: readString(securityContext?.manifestDigest) ?? readString(request.manifestDigest),
  };
}

function mergeApprovalDetails(base: ExecApprovalRequest, details: unknown): ExecApprovalRequest {
  const detailsRecord = asRecord(details);
  const request = asRecord(detailsRecord?.request) ?? detailsRecord;
  if (!request) return base;
  const securityContext = asRecord(request.securityContext);

  return {
    id: base.id,
    command: readString(request.command)
      ?? readString(request.commandText)
      ?? readString(request.commandPreview)
      ?? base.command,
    cwd: readString(request.cwd) ?? base.cwd,
    sessionKey: readString(request.sessionKey) ?? base.sessionKey,
    agentId: readString(request.agentId) ?? base.agentId,
    host: readString(request.host) ?? base.host,
    skillId: readString(securityContext?.skillId) ?? readString(request.skillId) ?? base.skillId,
    manifestDigest: readString(securityContext?.manifestDigest) ?? readString(request.manifestDigest) ?? base.manifestDigest,
  };
}

function normalizeForPathSearch(value: string): string {
  return value.replace(/\//g, path.sep).replace(/\\+/g, path.sep);
}

function extractSkillIdFromPathLikeText(text: string | undefined): string | null {
  if (!text) return null;
  const normalized = normalizeForPathSearch(text);
  const skillsRoot = path.resolve(process.env.CLAWX_TEST_OPENCLAW_SKILLS_DIR || getOpenClawSkillsDir());
  const marker = `${skillsRoot}${path.sep}`;
  const index = normalized.toLowerCase().indexOf(marker.toLowerCase());
  if (index < 0) return null;
  const rest = normalized.slice(index + marker.length);
  const skillId = rest.split(path.sep).find(Boolean);
  return skillId?.trim() || null;
}

async function inferSkillContextFromApproval(approval: ExecApprovalRequest): Promise<InferredSkillContext | null> {
  return await inferSkillContextFromCommand(approval.command, approval.cwd);
}

export async function inferSkillContextFromCommand(
  command: string | undefined,
  cwd: string | undefined,
): Promise<InferredSkillContext | null> {
  const skillId = extractSkillIdFromPathLikeText(command) ?? extractSkillIdFromPathLikeText(cwd);
  if (!skillId) return null;
  try {
    const skillsRoot = process.env.CLAWX_TEST_OPENCLAW_SKILLS_DIR || getOpenClawSkillsDir();
    const manifest = await readFile(path.join(skillsRoot, skillId, 'SKILL.md'));
    return {
      skillId,
      manifestDigest: crypto.createHash('sha256').update(manifest).digest('hex'),
    };
  } catch (error) {
    logger.warn('[security:gateway-exec] Failed to infer Skill runtime context from command path', {
      skillId,
      error: String(error),
    });
    return null;
  }
}

async function resolveApproval(
  request: GatewayRequest,
  id: string,
  decision: 'allow-once' | 'deny',
): Promise<void> {
  await request('exec.approval.resolve', { id, decision }, 10000);
}

export async function handleGatewayExecApprovalRequested(
  payload: unknown,
  deps: GatewayExecApprovalBridgeDeps,
): Promise<boolean> {
  const initial = extractRequestPayload(payload);
  if (!initial) return false;

  const details = await deps.request('exec.approval.get', { id: initial.id }, 10000)
    .catch((error) => {
      logger.warn(`[security:gateway-exec] Failed to load approval details for ${initial.id}: ${String(error)}`);
      return null;
    });
  const approval = mergeApprovalDetails(initial, details);

  if (!approval.command) {
    logger.warn(`[security:gateway-exec] Denying approval ${initial.id}: missing command`);
    await resolveApproval(deps.request, initial.id, 'deny');
    return true;
  }

  const approveCommand = deps.approveCommand ?? assertCommandAllowedWithConfirmation;
  try {
    const inferredSkill = approval.skillId && approval.manifestDigest
      ? null
      : await inferSkillContextFromApproval(approval);
    const skillId = approval.skillId ?? inferredSkill?.skillId;
    const manifestDigest = approval.manifestDigest ?? inferredSkill?.manifestDigest;

    if (skillId || manifestDigest) {
      if (!skillId || !manifestDigest) {
        throw new Error('Skill runtime exec approval is missing skillId or manifestDigest');
      }
      const approveSkillCommand = deps.approveSkillCommand ?? (async (input) => {
        await assertSkillRuntimeCommandAllowed({
          kind: 'command',
          context: input.context,
          command: input.command,
          cwd: input.cwd,
        });
      });
      await approveSkillCommand({
        context: {
          skillId,
          manifestDigest,
          source: `gateway:runtime-exec:skill:${skillId}`,
        },
        command: approval.command,
        cwd: approval.cwd,
      });
    } else {
      await approveCommand({
        command: approval.command,
        cwd: approval.cwd,
        source: approval.agentId
          ? `gateway:runtime-exec:${approval.agentId}`
          : 'gateway:runtime-exec',
      });
    }
    await resolveApproval(deps.request, approval.id, 'allow-once');
    logger.info('[security:gateway-exec] Runtime exec approval allowed', {
      approvalId: approval.id,
      sessionKey: approval.sessionKey,
      agentId: approval.agentId,
      cwd: approval.cwd,
    });
  } catch (error) {
    await resolveApproval(deps.request, approval.id, 'deny').catch((resolveError) => {
      logger.warn(`[security:gateway-exec] Failed to deny approval ${approval.id}: ${String(resolveError)}`);
    });
    logger.warn('[security:gateway-exec] Runtime exec approval denied', {
      approvalId: approval.id,
      sessionKey: approval.sessionKey,
      agentId: approval.agentId,
      cwd: approval.cwd,
      error: String(error),
    });
  }

  return true;
}
