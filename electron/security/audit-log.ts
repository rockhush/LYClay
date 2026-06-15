import crypto from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger';
import { getDataDir } from '../utils/paths';
import { redactSecrets, redactUnknown } from './secret-scanner';
import type {
  CommandGrant,
  DomainGrant,
  McpServerGrant,
  PathGrant,
  PathPolicyRequest,
  PathPolicyResult,
  SecurityAuditEvent,
  SecurityConfirmationRequest,
  SecurityConfirmationResponse,
  SecurityPolicyRequest,
  SecurityPolicyResult,
  SkillGrant,
} from './types';

const MAX_MEMORY_EVENTS = 500;
const DEFAULT_MAX_AUDIT_LOG_BYTES = 2 * 1024 * 1024;
const auditEvents: SecurityAuditEvent[] = [];

export interface SecurityAuditQuery {
  limit?: number;
  capability?: SecurityAuditEvent['capability'];
  decision?: SecurityAuditEvent['decision'];
  source?: string;
}

export interface SecurityAuditPageQuery extends Omit<SecurityAuditQuery, 'limit'> {
  page?: number;
  pageSize?: number;
}

export interface SecurityAuditPage {
  events: SecurityAuditEvent[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

function getAuditLogPath(): string {
  return process.env.CLAWX_SECURITY_AUDIT_LOG_PATH
    || path.join(getDataDir(), 'security', 'audit-log.jsonl');
}

function getMaxAuditLogBytes(): number {
  const raw = Number(process.env.CLAWX_SECURITY_AUDIT_LOG_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_AUDIT_LOG_BYTES;
}

function targetForPolicyRequest(request: SecurityPolicyRequest, result: SecurityPolicyResult): string | undefined {
  switch (request.kind) {
    case 'file':
      return result.kind === 'file' ? result.result.pathInfo?.absolutePath ?? request.path : request.path;
    case 'command':
      return result.kind === 'command' ? result.result.command : request.command ?? request.executable;
    case 'network':
      return result.kind === 'network' ? result.result.url ?? request.url : request.url;
    case 'open-target':
      return result.kind === 'open-target'
        ? result.result.url ?? result.result.realPath ?? request.target
        : request.target;
    case 'prompt-scan':
      return request.name ?? request.source;
    default: {
      const exhaustive: never = request;
      return JSON.stringify(exhaustive);
    }
  }
}

function operationForPolicyRequest(request: SecurityPolicyRequest): string | undefined {
  switch (request.kind) {
    case 'file':
      return request.operation;
    case 'command':
      return 'execute';
    case 'network':
      return 'connect';
    case 'open-target':
      return request.capability;
    case 'prompt-scan':
      return request.source;
    default: {
      const exhaustive: never = request;
      return JSON.stringify(exhaustive);
    }
  }
}

function sourceForPolicyRequest(request: SecurityPolicyRequest): string {
  return typeof request.source === 'string' ? request.source : 'unknown';
}

function logEvent(event: SecurityAuditEvent): void {
  if (event.decision === 'deny' || event.risk === 'critical' || event.risk === 'high') {
    logger.warn('[security:audit]', event);
  } else {
    logger.info('[security:audit]', event);
  }
}

function redactAuditEvent(event: SecurityAuditEvent): SecurityAuditEvent {
  return {
    ...event,
    source: redactSecrets(event.source),
    ...(event.subject ? { subject: redactSecrets(event.subject) } : {}),
    ...(event.operation ? { operation: redactSecrets(event.operation) } : {}),
    ...(event.target ? { target: redactSecrets(event.target) } : {}),
    ...(event.reasons ? { reasons: event.reasons.map(redactSecrets) } : {}),
    ...(event.code ? { code: redactSecrets(event.code) } : {}),
    ...(event.metadata ? { metadata: redactUnknown(event.metadata) as Record<string, unknown> } : {}),
  };
}

function rotateAuditLogIfNeeded(filePath: string): void {
  if (!existsSync(filePath)) return;
  const maxBytes = getMaxAuditLogBytes();
  if (statSync(filePath).size < maxBytes) return;
  const rotatedPath = `${filePath}.1`;
  if (existsSync(rotatedPath)) {
    unlinkSync(rotatedPath);
  }
  renameSync(filePath, rotatedPath);
}

function persistAuditEvent(event: SecurityAuditEvent): void {
  try {
    const filePath = getAuditLogPath();
    mkdirSync(path.dirname(filePath), { recursive: true });
    rotateAuditLogIfNeeded(filePath);
    appendFileSync(filePath, `${JSON.stringify(redactAuditEvent(event))}\n`, 'utf8');
  } catch (error) {
    logger.warn('[security:audit] Failed to persist audit event', { error: String(error) });
  }
}

export function auditSecurityEvent(event: Omit<SecurityAuditEvent, 'id' | 'ts'> & Partial<Pick<SecurityAuditEvent, 'id' | 'ts'>>): SecurityAuditEvent {
  const normalized = redactAuditEvent({
    id: event.id ?? crypto.randomUUID(),
    ts: event.ts ?? Date.now(),
    source: event.source,
    capability: event.capability,
    decision: event.decision,
    ...(event.subject ? { subject: event.subject } : {}),
    ...(event.operation ? { operation: event.operation } : {}),
    ...(event.target ? { target: event.target } : {}),
    ...(event.risk ? { risk: event.risk } : {}),
    ...(event.reasons ? { reasons: event.reasons } : {}),
    ...(event.code ? { code: event.code } : {}),
    ...(event.metadata ? { metadata: event.metadata } : {}),
  });
  auditEvents.push(normalized);
  if (auditEvents.length > MAX_MEMORY_EVENTS) {
    auditEvents.splice(0, auditEvents.length - MAX_MEMORY_EVENTS);
  }
  logEvent(normalized);
  persistAuditEvent(normalized);
  return normalized;
}

export function auditPolicyDecision(request: SecurityPolicyRequest, result: SecurityPolicyResult): SecurityAuditEvent {
  return auditSecurityEvent({
    source: sourceForPolicyRequest(request),
    capability: request.kind,
    operation: operationForPolicyRequest(request),
    target: targetForPolicyRequest(request, result),
    decision: result.decision.action,
    risk: result.decision.risk,
    reasons: result.decision.reasons,
    code: result.decision.action === 'deny' ? result.decision.code : undefined,
  });
}

export function auditPathDecision(request: PathPolicyRequest, result: PathPolicyResult): void {
  if (result.decision.action === 'allow') return;
  auditSecurityEvent({
    source: request.source ?? 'unknown',
    capability: 'file',
    operation: request.capability,
    target: result.pathInfo?.absolutePath ?? request.path,
    decision: result.decision.action,
    risk: result.decision.risk,
    reasons: result.decision.reasons,
    code: result.decision.action === 'deny' ? result.decision.code : undefined,
  });
}

export function auditConfirmationDecision(
  request: SecurityConfirmationRequest,
  response: SecurityConfirmationResponse,
): SecurityAuditEvent {
  return auditSecurityEvent({
    source: request.source,
    capability: 'confirmation',
    operation: request.kind,
    target: request.kind === 'command'
      ? request.target.command
      : request.kind === 'network'
        ? request.target.url
        : request.kind === 'open-target'
          ? request.target.url
          : request.kind === 'file'
            ? request.target.path
            : request.target.summary,
    decision: response.choice === 'deny' ? 'deny' : 'confirm',
    risk: request.risk,
    reasons: request.reasons,
    code: response.choice === 'deny' ? `${request.kind.toUpperCase().replace(/-/g, '_')}_DENIED_BY_USER` : undefined,
    metadata: {
      choice: response.choice,
      confirmationId: request.id,
      kind: request.kind,
    },
  });
}

function permissionTarget(grant: PathGrant | DomainGrant | CommandGrant | McpServerGrant | SkillGrant): string {
  if (grant.resourceType === 'domain') return grant.domain;
  if (grant.resourceType === 'command') return grant.command;
  if (grant.resourceType === 'mcpServer') return grant.serverName;
  if (grant.resourceType === 'skill') return grant.skillId;
  return grant.path;
}

export function auditPermissionGrant(grant: PathGrant | DomainGrant | CommandGrant | McpServerGrant | SkillGrant): SecurityAuditEvent {
  return auditSecurityEvent({
    source: grant.source,
    subject: grant.subject,
    capability: 'permission',
    operation: `grant:${grant.resourceType}`,
    target: permissionTarget(grant),
    decision: 'grant',
    metadata: {
      grantId: grant.id,
      resourceType: grant.resourceType,
      scope: grant.scope,
      capabilities: grant.capabilities,
      expiresAt: grant.expiresAt,
      recursive: grant.resourceType === 'workspace' || grant.resourceType === 'file' || grant.resourceType === 'directory'
        ? grant.recursive
        : undefined,
      includeSubdomains: grant.resourceType === 'domain' ? grant.includeSubdomains : undefined,
      cwd: grant.resourceType === 'command' ? grant.cwd : undefined,
      transport: grant.resourceType === 'mcpServer' ? grant.transport : undefined,
      manifestDigest: grant.resourceType === 'skill' ? grant.manifestDigest : undefined,
    },
  });
}

export function auditPermissionRevoke(grant: PathGrant | DomainGrant | CommandGrant | McpServerGrant | SkillGrant): SecurityAuditEvent {
  return auditSecurityEvent({
    source: grant.source,
    subject: grant.subject,
    capability: 'permission',
    operation: `revoke:${grant.resourceType}`,
    target: permissionTarget(grant),
    decision: 'revoke',
    metadata: {
      grantId: grant.id,
      resourceType: grant.resourceType,
      scope: grant.scope,
      capabilities: grant.capabilities,
      revokedAt: grant.revokedAt,
    },
  });
}

export function auditPermissionInvalidate(grant: SkillGrant): SecurityAuditEvent {
  return auditSecurityEvent({
    source: grant.source,
    subject: grant.subject,
    capability: 'permission',
    operation: 'invalidate:skill',
    target: grant.skillId,
    decision: 'invalidate',
    metadata: {
      grantId: grant.id,
      resourceType: grant.resourceType,
      manifestDigest: grant.manifestDigest,
      invalidatedAt: grant.invalidatedAt,
    },
  });
}

export function listSecurityAuditEvents(): SecurityAuditEvent[] {
  return [...auditEvents];
}

export function clearSecurityAuditEventsForTests(): void {
  auditEvents.length = 0;
}

function parseAuditLine(line: string): SecurityAuditEvent | null {
  if (!line.trim()) return null;
  try {
    const parsed = JSON.parse(line) as Partial<SecurityAuditEvent>;
    if (
      typeof parsed.id !== 'string'
      || typeof parsed.ts !== 'number'
      || typeof parsed.source !== 'string'
      || typeof parsed.capability !== 'string'
      || typeof parsed.decision !== 'string'
    ) {
      return null;
    }
    return parsed as SecurityAuditEvent;
  } catch {
    return null;
  }
}

function readAuditFile(filePath: string): SecurityAuditEvent[] {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map(parseAuditLine)
    .filter((event): event is SecurityAuditEvent => event != null);
}

function collectSecurityAuditEvents(query: Omit<SecurityAuditQuery, 'limit'> = {}): SecurityAuditEvent[] {
  const filePath = getAuditLogPath();
  const events = [
    ...readAuditFile(`${filePath}.1`),
    ...readAuditFile(filePath),
    ...auditEvents,
  ];
  const unique = new Map<string, SecurityAuditEvent>();
  for (const event of events) {
    unique.set(event.id, event);
  }
  return [...unique.values()]
    .filter((event) => !query.capability || event.capability === query.capability)
    .filter((event) => !query.decision || event.decision === query.decision)
    .filter((event) => !query.source || event.source.includes(query.source))
    .sort((a, b) => b.ts - a.ts);
}

export function querySecurityAuditEvents(query: SecurityAuditQuery = {}): SecurityAuditEvent[] {
  const limit = Math.max(1, Math.min(query.limit ?? 100, 1000));
  return collectSecurityAuditEvents(query).slice(0, limit);
}

export function querySecurityAuditEventPage(query: SecurityAuditPageQuery = {}): SecurityAuditPage {
  const requestedPage = Math.max(1, Math.floor(query.page ?? 1));
  const pageSize = Math.max(1, Math.min(Math.floor(query.pageSize ?? 10), 100));
  const matchingEvents = collectSecurityAuditEvents(query);
  const total = matchingEvents.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const start = (page - 1) * pageSize;

  return {
    events: matchingEvents.slice(start, start + pageSize),
    total,
    page,
    pageSize,
    totalPages,
  };
}
