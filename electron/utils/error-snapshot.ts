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

export interface ErrorSnapshotInput {
  priority: SnapshotPriority;
  level: string;
  source: string;
  eventName: string;
  component?: string;
  errorCode: string;
  message: string;
  requestId?: string;
  runId?: string;
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

export interface SnapshotPriorityClassificationInput {
  source?: string;
  level?: string;
  status?: string;
  errorCode?: string;
  recovered?: boolean;
}

export interface ErrorSnapshotDocument {
  documentType: 'error_snapshot';
  schemaVersion: 1;
  snapshotId: string;
  ts: string;
  priority: SnapshotPriority;
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
  drain(priority?: SnapshotPriority): ErrorSnapshotDocument[];
  size(): number;
  bytes(): number;
}

const MAX_RECENT_EVENTS = 50;
const MAX_SNAPSHOT_BYTES = 64 * 1024;

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

export function classifySnapshotPriority(input: SnapshotPriorityClassificationInput): SnapshotPriority {
  const source = (input.source ?? '').toLowerCase();
  const level = (input.level ?? '').toLowerCase();
  const status = (input.status ?? '').toLowerCase();
  const errorCode = (input.errorCode ?? '').toUpperCase();

  if (input.recovered === true) return 'p1';
  if (source === 'security' || status === 'denied') return 'p1';
  if (level === 'fatal') return 'p0';

  const coreSources = new Set(['app', 'chat', 'gateway', 'model', 'provider', 'host-api']);
  const coreFailure = coreSources.has(source)
    && (level === 'error' || status === 'failed' || status === 'timeout' || errorCode.includes('TIMEOUT'));
  if (coreFailure) return 'p0';

  const diagnosticSources = new Set([
    'channel',
    'plugin',
    'skill',
    'usage',
    'dependency',
    'tool',
    'sub2api',
    'dws',
    'dingtalk',
    'oauth',
  ]);
  if (diagnosticSources.has(source)) return 'p1';

  return 'p1';
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
  const ts = options.now();
  const identity = await options.identity();
  const input = options.input;
  const baseUrl = input.baseUrl ? sanitizeBaseUrl(input.baseUrl) ?? undefined : undefined;
  const route = sanitizeUrlWithoutQuery(input.route);
  const metadata = sanitizeMetadata(input.metadata) ?? {};
  const recentEvents = options.contextBuffer.collect({
    at: ts,
    requestId: input.requestId,
    runId: input.runId,
    sessionId: input.sessionId,
    modelId: input.modelId,
    baseUrl,
    limit: MAX_RECENT_EVENTS,
  });

  const snapshot: ErrorSnapshotDocument = {
    documentType: 'error_snapshot',
    schemaVersion: 1,
    snapshotId: randomUUID(),
    ts,
    priority: input.priority,
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
