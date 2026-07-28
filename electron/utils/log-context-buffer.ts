import { redactSecrets, redactUnknown } from '../security/secret-scanner';

type LogEventStatus = 'ok' | 'failed' | 'timeout' | 'denied' | 'recovered' | 'warn' | string;

export interface LogContextEventInput {
  ts?: string;
  eventName: string;
  component: string;
  source?: string;
  level?: string;
  method?: string;
  route?: string;
  status?: LogEventStatus;
  statusCode?: number;
  durationMs?: number;
  requestId?: string;
  runId?: string;
  sessionId?: string;
  modelId?: string;
  baseUrl?: string;
  errorCode?: string;
  retryCount?: number;
  fallbackUsed?: boolean;
  recovered?: boolean;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface LogContextEvent {
  ts: string;
  eventName: string;
  component: string;
  source?: string;
  level?: string;
  method?: string;
  route?: string;
  status?: LogEventStatus;
  statusCode?: number;
  durationMs?: number;
  requestId?: string;
  runId?: string;
  sessionId?: string;
  modelId?: string;
  baseUrl?: string;
  errorCode?: string;
  retryCount?: number;
  fallbackUsed?: boolean;
  recovered?: boolean;
  metadata?: Record<string, unknown>;
}

export interface LogContextCollectCriteria {
  at?: string;
  requestId?: string;
  runId?: string;
  sessionId?: string;
  modelId?: string;
  baseUrl?: string;
  limit?: number;
}

export interface LogContextBuffer {
  record(event: LogContextEventInput): void;
  collect(criteria: LogContextCollectCriteria): LogContextEvent[];
}

const DROPPED_METADATA_KEY_PATTERN =
  /^(prompt|prompts|response|responses|transcript|transcripts|fileContent|content|body|rawBody|requestBody|responseBody|messages|messageContent|completion|input|output)$/i;

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? redactSecrets(trimmed) : undefined;
}

function normalizeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function sanitizeUrlWithoutQuery(input: unknown): string | undefined {
  const value = normalizeText(input);
  if (!value) return undefined;

  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, url.pathname === '/' ? '/' : '');
  } catch {
    const [withoutHash] = value.split('#');
    const [withoutQuery] = withoutHash.split('?');
    return withoutQuery || undefined;
  }
}

function sanitizeMetadataValue(value: unknown): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value;
  if (Array.isArray(value)) {
    return value.map(sanitizeMetadataValue).filter((item) => item !== undefined);
  }
  if (typeof value !== 'object') return undefined;

  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (DROPPED_METADATA_KEY_PATTERN.test(key)) continue;
    const sanitized = sanitizeMetadataValue(nested);
    if (sanitized !== undefined) out[key] = sanitized;
  }
  return redactUnknown(out);
}

export function sanitizeMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const sanitized = sanitizeMetadataValue(value);
  if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized)) return undefined;
  return Object.keys(sanitized).length > 0 ? sanitized as Record<string, unknown> : undefined;
}

function sanitizeEvent(input: LogContextEventInput): LogContextEvent {
  const event: LogContextEvent = {
    ts: normalizeText(input.ts) ?? new Date().toISOString(),
    eventName: normalizeText(input.eventName) ?? 'unknown.event',
    component: normalizeText(input.component) ?? 'unknown',
  };

  const stringFields = [
    'source',
    'level',
    'method',
    'status',
    'requestId',
    'runId',
    'sessionId',
    'modelId',
    'errorCode',
  ] as const;
  for (const field of stringFields) {
    const normalized = normalizeText(input[field]);
    if (normalized) event[field] = normalized;
  }

  const route = sanitizeUrlWithoutQuery(input.route);
  if (route) event.route = route;
  const baseUrl = sanitizeUrlWithoutQuery(input.baseUrl);
  if (baseUrl) event.baseUrl = baseUrl;

  const statusCode = normalizeNumber(input.statusCode);
  if (statusCode !== undefined) event.statusCode = statusCode;
  const durationMs = normalizeNumber(input.durationMs);
  if (durationMs !== undefined) event.durationMs = durationMs;
  const retryCount = normalizeNumber(input.retryCount);
  if (retryCount !== undefined) event.retryCount = retryCount;

  const fallbackUsed = normalizeBoolean(input.fallbackUsed);
  if (fallbackUsed !== undefined) event.fallbackUsed = fallbackUsed;
  const recovered = normalizeBoolean(input.recovered);
  if (recovered !== undefined) event.recovered = recovered;

  const metadata = sanitizeMetadata(input.metadata);
  if (metadata) event.metadata = metadata;

  return event;
}

function toTime(value: string | undefined): number {
  const time = value ? Date.parse(value) : Date.now();
  return Number.isFinite(time) ? time : Date.now();
}

function hasCorrelation(criteria: LogContextCollectCriteria, event: LogContextEvent): boolean {
  const wantedBaseUrl = sanitizeUrlWithoutQuery(criteria.baseUrl);
  return Boolean(
    (criteria.requestId && criteria.requestId === event.requestId) ||
    (criteria.runId && criteria.runId === event.runId) ||
    (criteria.sessionId && criteria.sessionId === event.sessionId) ||
    (criteria.modelId && criteria.modelId === event.modelId) ||
    (wantedBaseUrl && wantedBaseUrl === event.baseUrl),
  );
}

export function createLogContextBuffer(options: { windowMs: number; maxEvents: number }): LogContextBuffer {
  const events: LogContextEvent[] = [];
  const windowMs = Math.max(1, options.windowMs);
  const maxEvents = Math.max(1, options.maxEvents);

  function prune(now: number): void {
    const minTime = now - windowMs;
    while (events.length > 0 && toTime(events[0].ts) < minTime) {
      events.shift();
    }
    while (events.length > maxEvents) {
      events.shift();
    }
  }

  return {
    record(input) {
      const event = sanitizeEvent(input);
      events.push(event);
      prune(toTime(event.ts));
    },
    collect(criteria) {
      const at = toTime(criteria.at);
      prune(at);
      const limit = Math.max(1, criteria.limit ?? 50);
      const hasAnyCriterion = Boolean(
        criteria.requestId || criteria.runId || criteria.sessionId || criteria.modelId || criteria.baseUrl,
      );

      return events
        .filter((event) => Math.abs(at - toTime(event.ts)) <= windowMs)
        .filter((event) => !hasAnyCriterion || hasCorrelation(criteria, event))
        .slice(-limit);
    },
  };
}
