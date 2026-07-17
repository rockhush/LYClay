import { assertSkillWorkshopActionAllowedWithConfirmation } from '../security/confirmation-service';
import { logger } from '../utils/logger';

type GatewayRequest = (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>;

export interface GatewayPluginApprovalBridgeDeps {
  request: GatewayRequest;
  approveSkillWorkshopAction?: (input: {
    action: 'apply' | 'reject' | 'quarantine';
    title: string;
    description?: string;
    toolCallId?: string;
    source?: string;
  }) => Promise<void>;
}

interface PluginApprovalRequest {
  id: string;
  action: 'apply' | 'reject' | 'quarantine';
  title: string;
  description?: string;
  toolCallId?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readAction(value: unknown): PluginApprovalRequest['action'] | undefined {
  const action = readString(value);
  return action === 'apply' || action === 'reject' || action === 'quarantine'
    ? action
    : undefined;
}

function extractRequestPayload(payload: unknown): Partial<PluginApprovalRequest> | null {
  const record = asRecord(payload);
  if (!record) return null;

  const id = readString(record.id) ?? readString(record.approvalId);
  const request = asRecord(record.request) ?? asRecord(record.proposal) ?? record;
  if (!id) return null;

  return {
    id,
    action: readAction(request.action) ?? readAction(record.action),
    title: readString(request.title)
      ?? readString(request.name)
      ?? readString(request.skillName)
      ?? readString(record.title),
    description: readString(request.description)
      ?? readString(request.summary)
      ?? readString(record.description),
    toolCallId: readString(request.toolCallId) ?? readString(record.toolCallId),
  };
}

function mergeApprovalDetails(
  base: Partial<PluginApprovalRequest>,
  details: unknown,
): Partial<PluginApprovalRequest> {
  const detailsRecord = asRecord(details);
  const request = asRecord(detailsRecord?.request) ?? asRecord(detailsRecord?.proposal) ?? detailsRecord;
  if (!request) return base;

  return {
    id: base.id,
    action: readAction(request.action) ?? base.action,
    title: readString(request.title)
      ?? readString(request.name)
      ?? readString(request.skillName)
      ?? base.title,
    description: readString(request.description)
      ?? readString(request.summary)
      ?? base.description,
    toolCallId: readString(request.toolCallId) ?? base.toolCallId,
  };
}

async function resolveApproval(
  request: GatewayRequest,
  id: string,
  decision: 'allow-once' | 'deny',
): Promise<void> {
  await request('plugin.approval.resolve', { id, decision }, 10000);
}

export async function handleGatewayPluginApprovalRequested(
  payload: unknown,
  deps: GatewayPluginApprovalBridgeDeps,
): Promise<boolean> {
  const initial = extractRequestPayload(payload);
  if (!initial?.id) return false;

  const details = await deps.request('plugin.approval.get', { id: initial.id }, 10000)
    .catch((error) => {
      logger.warn(`[security:gateway-plugin] Failed to load approval details for ${initial.id}: ${String(error)}`);
      return null;
    });
  const approval = mergeApprovalDetails(initial, details);

  if (!approval.action || !approval.title) {
    logger.warn(`[security:gateway-plugin] Denying approval ${initial.id}: missing action or title`);
    await resolveApproval(deps.request, initial.id, 'deny');
    return true;
  }

  const approveSkillWorkshopAction = deps.approveSkillWorkshopAction
    ?? assertSkillWorkshopActionAllowedWithConfirmation;

  try {
    await approveSkillWorkshopAction({
      action: approval.action,
      title: approval.title,
      description: approval.description,
      toolCallId: approval.toolCallId,
      source: 'gateway:plugin-approval:skill-workshop',
    });
    await resolveApproval(deps.request, initial.id, 'allow-once');
    logger.info('[security:gateway-plugin] Plugin approval allowed', {
      approvalId: initial.id,
      action: approval.action,
      title: approval.title,
      toolCallId: approval.toolCallId,
    });
  } catch (error) {
    await resolveApproval(deps.request, initial.id, 'deny').catch((resolveError) => {
      logger.warn(`[security:gateway-plugin] Failed to deny approval ${initial.id}: ${String(resolveError)}`);
    });
    logger.warn('[security:gateway-plugin] Plugin approval denied', {
      approvalId: initial.id,
      action: approval.action,
      title: approval.title,
      toolCallId: approval.toolCallId,
      error: String(error),
    });
  }

  return true;
}
