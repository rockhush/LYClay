import { assertSkillWorkshopActionAllowedWithConfirmation } from '../security/confirmation-service';
import { logger } from '../utils/logger';

type GatewayRequest = (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>;
type SkillWorkshopAction = 'apply' | 'reject' | 'quarantine';

export interface GatewayPluginApprovalBridgeDeps {
  request: GatewayRequest;
  approve?: (input: {
    action: SkillWorkshopAction;
    title: string;
    description?: string;
    toolCallId?: string;
    source: string;
  }) => Promise<void>;
}

interface SkillWorkshopApprovalRequest {
  id: string;
  action: SkillWorkshopAction;
  title: string;
  description?: string;
  toolCallId?: string;
  agentId?: string;
  sessionKey?: string;
}

const ACTION_BY_TITLE: Readonly<Record<string, SkillWorkshopAction>> = {
  'Apply workspace skill proposal': 'apply',
  'Reject workspace skill proposal': 'reject',
  'Quarantine workspace skill proposal': 'quarantine',
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function extractSkillWorkshopApproval(payload: unknown): SkillWorkshopApprovalRequest | null {
  const record = asRecord(payload);
  const request = asRecord(record?.request);
  const id = readString(record?.id) ?? readString(record?.approvalId);
  if (!record || !request || !id) return null;

  const title = readString(request.title);
  const toolName = readString(request.toolName);
  const action = title ? ACTION_BY_TITLE[title] : undefined;
  const allowedDecisions = Array.isArray(request.allowedDecisions)
    ? request.allowedDecisions.filter((value): value is string => typeof value === 'string')
    : [];
  if (
    toolName !== 'skill_workshop'
    || !title
    || !action
    || !allowedDecisions.includes('allow-once')
    || !allowedDecisions.includes('deny')
  ) return null;

  return {
    id,
    action,
    title,
    ...(readString(request.description) ? { description: readString(request.description) } : {}),
    ...(readString(request.toolCallId) ? { toolCallId: readString(request.toolCallId) } : {}),
    ...(readString(request.agentId) ? { agentId: readString(request.agentId) } : {}),
    ...(readString(request.sessionKey) ? { sessionKey: readString(request.sessionKey) } : {}),
  };
}

async function resolveApproval(
  request: GatewayRequest,
  id: string,
  decision: 'allow-once' | 'deny',
): Promise<void> {
  await request('plugin.approval.resolve', { id, decision }, 10_000);
}

export async function handleGatewayPluginApprovalRequested(
  payload: unknown,
  deps: GatewayPluginApprovalBridgeDeps,
): Promise<boolean> {
  const record = asRecord(payload);
  const id = readString(record?.id) ?? readString(record?.approvalId);
  const approval = extractSkillWorkshopApproval(payload);
  if (!approval) {
    if (id) {
      await resolveApproval(deps.request, id, 'deny').catch((error) => {
        logger.warn(`[security:gateway-plugin] Failed to deny unsupported plugin approval ${id}: ${String(error)}`);
      });
      return true;
    }
    return false;
  }

  const approve = deps.approve ?? assertSkillWorkshopActionAllowedWithConfirmation;
  try {
    await approve({
      action: approval.action,
      title: approval.title,
      ...(approval.description ? { description: approval.description } : {}),
      ...(approval.toolCallId ? { toolCallId: approval.toolCallId } : {}),
      source: approval.agentId
        ? `gateway:plugin-approval:skill-workshop:${approval.agentId}`
        : 'gateway:plugin-approval:skill-workshop',
    });
    await resolveApproval(deps.request, approval.id, 'allow-once');
    logger.info('[security:gateway-plugin] Skill Workshop approval allowed', {
      approvalId: approval.id,
      action: approval.action,
      sessionKey: approval.sessionKey,
      agentId: approval.agentId,
    });
  } catch (error) {
    await resolveApproval(deps.request, approval.id, 'deny').catch((resolveError) => {
      logger.warn(`[security:gateway-plugin] Failed to deny approval ${approval.id}: ${String(resolveError)}`);
    });
    logger.warn('[security:gateway-plugin] Skill Workshop approval denied', {
      approvalId: approval.id,
      action: approval.action,
      sessionKey: approval.sessionKey,
      agentId: approval.agentId,
      error: String(error),
    });
  }
  return true;
}
