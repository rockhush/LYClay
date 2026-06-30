export interface CronSessionKeyParts {
  agentId: string;
  jobId: string;
  runSessionId?: string;
}

export function parseCronSessionKey(sessionKey: string): CronSessionKeyParts | null {
  if (!sessionKey.startsWith('agent:')) return null;
  const parts = sessionKey.split(':');
  if (parts.length < 4) return null;

  const agentId = parts[1] || 'main';
  const namespace = parts[2];

  // New LYClaw streaming runs: agent:agentId:scheduled-task:jobId:runSessionId
  if (namespace === 'scheduled-task' && parts.length >= 5) {
    const jobId = parts[3];
    const runSessionId = parts[4];
    if (!jobId || !runSessionId) return null;
    return { agentId, jobId, runSessionId };
  }

  // New streaming runs: agent:agentId:cron-run:jobId:runSessionId
  if (namespace === 'cron-run' && parts.length >= 5) {
    const jobId = parts[3];
    const runSessionId = parts[4];
    if (!jobId || !runSessionId) return null;
    return { agentId, jobId, runSessionId };
  }

  // Legacy aggregate/run sessions: agent:agentId:cron:jobId[:runSessionId][:run:runSessionId]
  if (namespace !== 'cron') return null;

  const jobId = parts[3];
  if (!jobId) return null;

  if (parts.length === 4) {
    return { agentId, jobId };
  }

  if (parts.length === 5 && parts[4]) {
    return { agentId, jobId, runSessionId: parts[4] };
  }

  if (parts.length === 6 && parts[4] === 'run' && parts[5]) {
    return { agentId, jobId, runSessionId: parts[5] };
  }

  return null;
}

export function isCronSessionKey(sessionKey: string): boolean {
  return parseCronSessionKey(sessionKey) != null;
}

const CRON_BRACKET_LABEL = /^\[cron:[^\]]*\]$/i;
const CRON_BRACKET_PREFIX = /^\[cron:[^\]]*\]\s*/i;
const CRON_BRACKET_ANYWHERE = /\s*\[cron:[^\]]*\]\s*/gi;

export interface CronSessionDisplayLabelOptions {
  jobName?: string;
  fallback?: string;
}

/**
 * Normalize cron session labels for UI display — strips internal `[cron:uuid]` ids.
 */
export function formatCronSessionDisplayLabel(
  label: string,
  options?: CronSessionDisplayLabelOptions,
): string {
  const fallback = options?.fallback ?? 'Cron';
  const jobName = options?.jobName?.trim();

  let text = label.trim();
  if (
    text.startsWith('agent:')
    && (text.includes(':cron:') || text.includes(':cron-run:') || text.includes(':scheduled-task:'))
  ) {
    text = '';
  }

  if (!text) {
    return jobName ? `Cron: ${jobName}` : fallback;
  }

  if (CRON_BRACKET_LABEL.test(text)) {
    return jobName ? `Cron: ${jobName}` : fallback;
  }

  text = text.replace(CRON_BRACKET_PREFIX, '').trim();
  text = text.replace(CRON_BRACKET_ANYWHERE, ' ').replace(/\s+/g, ' ').trim();

  if (!text) {
    return jobName ? `Cron: ${jobName}` : fallback;
  }

  return text;
}

export function buildCronSessionHistoryPath(sessionKey: string, limit = 200): string {
  const params = new URLSearchParams({ sessionKey });
  if (Number.isFinite(limit) && limit > 0) {
    params.set('limit', String(Math.floor(limit)));
  }
  return `/api/cron/session-history?${params.toString()}`;
}

function cronMessageTimestampMs(message: { timestamp?: unknown }): number {
  if (typeof message.timestamp !== 'number' || !Number.isFinite(message.timestamp)) {
    return 0;
  }
  return message.timestamp < 1e12 ? message.timestamp * 1000 : message.timestamp;
}

function cronMessageDedupeKey(message: { role?: unknown; content?: unknown; timestamp?: unknown }): string {
  const role = typeof message.role === 'string' ? message.role : '';
  const content = typeof message.content === 'string'
    ? message.content
    : JSON.stringify(message.content ?? '');
  return `${cronMessageTimestampMs(message)}|${role}|${content.slice(0, 240)}`;
}

/** Merge aggregated cron run history with the latest single-run transcript. */
export function mergeCronSessionHistory<T extends { role?: unknown; content?: unknown; timestamp?: unknown }>(
  aggregated: T[],
  latestRunMessages: T[],
): T[] {
  if (aggregated.length === 0) return latestRunMessages;
  if (latestRunMessages.length === 0) return aggregated;

  const latestAggregatedTs = aggregated.reduce(
    (max, message) => Math.max(max, cronMessageTimestampMs(message)),
    0,
  );
  const seen = new Set(aggregated.map(cronMessageDedupeKey));
  const appended = latestRunMessages.filter((message) => {
    const ts = cronMessageTimestampMs(message);
    if (latestAggregatedTs > 0 && ts <= latestAggregatedTs - 60_000) {
      return false;
    }
    const key = cronMessageDedupeKey(message);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (appended.length === 0) return aggregated;
  return [...aggregated, ...appended].sort(
    (left, right) => cronMessageTimestampMs(left) - cronMessageTimestampMs(right),
  );
}
