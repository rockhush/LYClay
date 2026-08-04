import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { redactSecrets } from '../security/secret-scanner';
import {
  type LogContextBuffer,
  type LogContextEvent,
  sanitizeMetadata,
  sanitizeUrlWithoutQuery,
} from './log-context-buffer';
import type { LogIdentityContext } from './log-identity-context';

export type SnapshotPriority = 'p0' | 'p1';
export type SnapshotUserImpact = 'blocking';
export type SnapshotOperationKind = 'user_chat' | 'host_api_operation' | 'app_runtime';

export interface ErrorSnapshotInput {
  priority: SnapshotPriority;
  userImpact: SnapshotUserImpact;
  operationKind: SnapshotOperationKind;
  failureStage: string;
  fingerprint: string;
  occurrenceCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  level: string;
  source: string;
  eventName: string;
  component?: string;
  errorCode: string;
  message: string;
  requestId?: string;
  runId?: string;
  sessionKey?: string;
  sessionId?: string;
  modelId?: string;
  baseUrl?: string;
  method?: string;
  route?: string;
  status?: string;
  statusCode?: number;
  durationMs?: number;
  retryCount?: number;
  fallbackUsed?: boolean;
  recovered?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ErrorSnapshotDocument {
  documentType: 'error_snapshot';
  schemaVersion: 1;
  snapshotId: string;
  ts: string;
  priority: SnapshotPriority;
  userImpact: SnapshotUserImpact;
  operationKind: SnapshotOperationKind;
  failureStage: string;
  fingerprint: string;
  occurrenceCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  level: string;
  source: string;
  eventName: string;
  component: string;
  errorCode: string;
  message: string;
  workNo: string;
  userName: string;
  identityMissingReason: LogIdentityContext['identityMissingReason'];
  requestId?: string;
  runId?: string;
  sessionKey?: string;
  sessionId?: string;
  modelId?: string;
  baseUrl?: string;
  method?: string;
  route?: string;
  status?: string;
  statusCode?: number;
  durationMs?: number;
  retryCount?: number;
  fallbackUsed?: boolean;
  recovered?: boolean;
  recentEvents: LogContextEvent[];
  metadata: Record<string, unknown>;
  truncated: boolean;
}

export interface SnapshotWriteQueue {
  enqueue(snapshot: ErrorSnapshotDocument): void;
  restore(snapshots: ErrorSnapshotDocument[]): void;
  drain(priority?: SnapshotPriority): ErrorSnapshotDocument[];
  size(): number;
  bytes(): number;
}

const MAX_RECENT_EVENTS = 50;
const MAX_SNAPSHOT_BYTES = 64 * 1024;
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

function cleanString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? redactSecrets(trimmed) : undefined;
}

function cleanNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function cleanBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

export function formatBeijingLogTimestamp(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  const date = new Date(time + BEIJING_OFFSET_MS);
  return [
    date.getUTCFullYear(),
    pad2(date.getUTCMonth() + 1),
    pad2(date.getUTCDate()),
  ].join('-') + ` ${pad2(date.getUTCHours())}${pad2(date.getUTCMinutes())}${pad2(date.getUTCSeconds())}`;
}

export function sanitizeBaseUrl(input: string): string | null {
  const sanitized = sanitizeUrlWithoutQuery(input);
  if (!sanitized) return null;
  try {
    const url = new URL(sanitized);
    return `${url.protocol}//${url.host}${url.pathname}`.replace(/\/$/, url.pathname === '/' ? '/' : '');
  } catch {
    return null;
  }
}

export function isElkEligibleSnapshot(snapshot: unknown): snapshot is ErrorSnapshotDocument {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return false;
  const value = snapshot as Record<string, unknown>;
  return value.documentType === 'error_snapshot'
    && value.schemaVersion === 1
    && typeof value.snapshotId === 'string'
    && value.snapshotId.length > 0
    && typeof value.ts === 'string'
    && value.ts.length > 0
    && value.priority === 'p0'
    && value.userImpact === 'blocking'
    && (value.operationKind === 'user_chat'
      || value.operationKind === 'host_api_operation'
      || value.operationKind === 'app_runtime')
    && typeof value.failureStage === 'string'
    && value.failureStage.length > 0
    && typeof value.fingerprint === 'string'
    && value.fingerprint.length > 0
    && typeof value.occurrenceCount === 'number'
    && Number.isInteger(value.occurrenceCount)
    && value.occurrenceCount >= 1
    && typeof value.firstSeenAt === 'string'
    && value.firstSeenAt.length > 0
    && typeof value.lastSeenAt === 'string'
    && value.lastSeenAt.length > 0
    && typeof value.level === 'string'
    && value.level.length > 0
    && typeof value.source === 'string'
    && value.source.length > 0
    && typeof value.eventName === 'string'
    && value.eventName.length > 0
    && typeof value.component === 'string'
    && value.component.length > 0
    && typeof value.errorCode === 'string'
    && value.errorCode.length > 0
    && typeof value.message === 'string'
    && typeof value.workNo === 'string'
    && typeof value.userName === 'string'
    && (value.identityMissingReason === null || typeof value.identityMissingReason === 'string')
    && (value.sessionKey === undefined || typeof value.sessionKey === 'string')
    && (value.sessionId === undefined || typeof value.sessionId === 'string')
    && Array.isArray(value.recentEvents)
    && Boolean(value.metadata)
    && typeof value.metadata === 'object'
    && !Array.isArray(value.metadata)
    && typeof value.truncated === 'boolean';
}

function assignOptional<T extends keyof ErrorSnapshotDocument>(
  snapshot: ErrorSnapshotDocument,
  key: T,
  value: ErrorSnapshotDocument[T] | undefined,
): void {
  if (value !== undefined && value !== '') {
    snapshot[key] = value;
  }
}

function trimSnapshot(snapshot: ErrorSnapshotDocument): ErrorSnapshotDocument {
  let next = snapshot;
  while (Buffer.byteLength(JSON.stringify(next), 'utf8') > MAX_SNAPSHOT_BYTES && next.recentEvents.length > 0) {
    next = {
      ...next,
      recentEvents: next.recentEvents.slice(1),
      truncated: true,
    };
  }
  return next;
}

export async function buildErrorSnapshot(options: {
  now: () => string;
  identity: () => Promise<LogIdentityContext>;
  contextBuffer: LogContextBuffer;
  input: ErrorSnapshotInput;
}): Promise<ErrorSnapshotDocument> {
  const observedAt = options.now();
  const ts = formatBeijingLogTimestamp(observedAt);
  const identity = await options.identity();
  const input = options.input;
  const baseUrl = input.baseUrl ? sanitizeBaseUrl(input.baseUrl) ?? undefined : undefined;
  const route = sanitizeUrlWithoutQuery(input.route);
  const metadata = sanitizeMetadata(input.metadata) ?? {};
  const recentEvents = options.contextBuffer.collect({
    at: observedAt,
    requestId: input.requestId,
    runId: input.runId,
    sessionId: input.sessionKey,
    modelId: input.modelId,
    baseUrl,
    limit: MAX_RECENT_EVENTS,
  }).map((event) => ({
    ...event,
    ts: formatBeijingLogTimestamp(event.ts),
  }));

  const snapshot: ErrorSnapshotDocument = {
    documentType: 'error_snapshot',
    schemaVersion: 1,
    snapshotId: randomUUID(),
    ts,
    priority: input.priority,
    userImpact: input.userImpact,
    operationKind: input.operationKind,
    failureStage: cleanString(input.failureStage) ?? 'unknown',
    fingerprint: cleanString(input.fingerprint) ?? '',
    occurrenceCount: Math.max(1, Math.trunc(cleanNumber(input.occurrenceCount) ?? 1)),
    firstSeenAt: formatBeijingLogTimestamp(cleanString(input.firstSeenAt) ?? observedAt),
    lastSeenAt: formatBeijingLogTimestamp(cleanString(input.lastSeenAt) ?? observedAt),
    level: cleanString(input.level) ?? 'error',
    source: cleanString(input.source) ?? 'unknown',
    eventName: cleanString(input.eventName) ?? 'unknown.error',
    component: cleanString(input.component) ?? cleanString(input.source) ?? 'unknown',
    errorCode: cleanString(input.errorCode) ?? 'UNKNOWN_ERROR',
    message: cleanString(input.message) ?? '',
    workNo: identity.workNo,
    userName: identity.userName,
    identityMissingReason: identity.identityMissingReason,
    recentEvents,
    metadata,
    truncated: false,
  };

  assignOptional(snapshot, 'requestId', cleanString(input.requestId));
  assignOptional(snapshot, 'runId', cleanString(input.runId));
  assignOptional(snapshot, 'sessionKey', cleanString(input.sessionKey));
  assignOptional(snapshot, 'sessionId', cleanString(input.sessionId));
  assignOptional(snapshot, 'modelId', cleanString(input.modelId));
  assignOptional(snapshot, 'baseUrl', baseUrl);
  assignOptional(snapshot, 'method', cleanString(input.method));
  assignOptional(snapshot, 'route', route);
  assignOptional(snapshot, 'status', cleanString(input.status));
  assignOptional(snapshot, 'statusCode', cleanNumber(input.statusCode));
  assignOptional(snapshot, 'durationMs', cleanNumber(input.durationMs));
  assignOptional(snapshot, 'retryCount', cleanNumber(input.retryCount));
  assignOptional(snapshot, 'fallbackUsed', cleanBoolean(input.fallbackUsed));
  assignOptional(snapshot, 'recovered', cleanBoolean(input.recovered));

  return trimSnapshot(snapshot);
}

function snapshotBytes(snapshot: ErrorSnapshotDocument): number {
  return Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
}

export function createSnapshotWriteQueue(options: { maxItems: number; maxBytes: number }): SnapshotWriteQueue {
  const maxItems = Math.max(1, options.maxItems);
  const maxBytes = Math.max(1024, options.maxBytes);
  let items: ErrorSnapshotDocument[] = [];
  let totalBytes = 0;

  function removeAt(index: number): void {
    const [removed] = items.splice(index, 1);
    if (removed) totalBytes -= snapshotBytes(removed);
  }

  function compact(): void {
    while (items.length > maxItems || totalBytes > maxBytes) {
      const p1Index = items.findIndex((item) => item.priority === 'p1');
      removeAt(p1Index >= 0 ? p1Index : 0);
    }
  }

  return {
    enqueue(snapshot) {
      items.push(snapshot);
      totalBytes += snapshotBytes(snapshot);
      compact();
    },
    restore(snapshots) {
      items = [...snapshots, ...items];
      totalBytes = items.reduce((sum, snapshot) => sum + snapshotBytes(snapshot), 0);
      compact();
    },
    drain(priority) {
      const drained: ErrorSnapshotDocument[] = [];
      const remaining: ErrorSnapshotDocument[] = [];
      totalBytes = 0;

      for (const item of items) {
        if (!priority || item.priority === priority) {
          drained.push(item);
        } else {
          remaining.push(item);
          totalBytes += snapshotBytes(item);
        }
      }

      items = remaining;
      return drained.sort((a, b) => {
        if (a.priority === b.priority) return 0;
        return a.priority === 'p0' ? -1 : 1;
      });
    },
    size() {
      return items.length;
    },
    bytes() {
      return totalBytes;
    },
  };
}

export async function captureErrorSnapshot(options: {
  queue: SnapshotWriteQueue;
  scheduleWriter: (priority: SnapshotPriority) => void;
  contextBuffer: LogContextBuffer;
  identity: () => Promise<LogIdentityContext>;
  now: () => string;
  input: ErrorSnapshotInput;
}): Promise<void> {
  const snapshot = await buildErrorSnapshot({
    now: options.now,
    identity: options.identity,
    contextBuffer: options.contextBuffer,
    input: options.input,
  });

  options.queue.enqueue(snapshot);
  options.scheduleWriter(snapshot.priority);
}
