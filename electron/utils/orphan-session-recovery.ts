import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { logger } from './logger';

const SESSION_PREVIEW_MAX_LINES = 40;
const SESSION_PREVIEW_MAX_CHARS = 80;
const SESSION_PREVIEW_CONCURRENCY = 4;
const DEFAULT_MIN_AGE_DAYS = 14;

const KNOWN_CHANNEL_SESSION_IDS = new Set([
  'dingtalk',
  'feishu',
  'wecom',
  'qqbot',
  'telegram',
  'discord',
  'whatsapp',
  'wechat',
  'signal',
  'imessage',
  'matrix',
  'line',
  'msteams',
  'googlechat',
  'mattermost',
]);

export type OrphanRecoveredSession = {
  key: string;
  label?: string;
  firstUserMessagePreview?: string;
  lastMessageAt?: number;
  updatedAt?: number;
};

type OrphanRecoveryCacheEntry = {
  signature: string;
  sessions: OrphanRecoveredSession[];
};

const orphanRecoveryCache = new Map<string, OrphanRecoveryCacheEntry>();

function isSubagentSessionKey(sessionKey: string): boolean {
  return /:subagent:/i.test(sessionKey);
}

function isChannelMirrorSessionKey(sessionKey: string): boolean {
  const parts = sessionKey.split(':');
  const lowerParts = parts.map((part) => part.toLowerCase());
  return lowerParts.length >= 5
    && lowerParts[0] === 'agent'
    && KNOWN_CHANNEL_SESSION_IDS.has(lowerParts[2] ?? '')
    && lowerParts[3] === 'group';
}

function isHeartbeatSessionKey(sessionKey: string): boolean {
  const parts = sessionKey.split(':');
  return parts.length === 3 && parts[0] === 'agent' && parts[2] === 'main';
}

function isCronLikeSessionKey(sessionKey: string): boolean {
  const parts = sessionKey.split(':');
  if (parts.length < 4 || parts[0] !== 'agent') return false;
  const namespace = parts[2]?.toLowerCase();
  return namespace === 'cron' || namespace === 'cron-run' || namespace === 'scheduled-task';
}

export function isRecoverableOrphanSessionKey(sessionKey: string): boolean {
  if (!sessionKey.startsWith('agent:')) return false;
  if (sessionKey.includes('__warmup__')) return false;
  if (isSubagentSessionKey(sessionKey)) return false;
  if (isChannelMirrorSessionKey(sessionKey)) return false;
  if (isHeartbeatSessionKey(sessionKey)) return false;
  if (isCronLikeSessionKey(sessionKey)) return false;
  return true;
}

export function isOrphanTranscriptFileName(fileName: string): boolean {
  if (!fileName.endsWith('.jsonl')) return false;
  if (fileName.includes('.deleted.') || fileName.includes('.trajectory.')) return false;
  if (fileName.endsWith('.lock')) return false;
  return true;
}

export function inferSessionKeyFromOrphanFile(agentId: string, fileName: string): string | null {
  if (!isOrphanTranscriptFileName(fileName)) return null;
  const suffix = fileName.slice(0, -'.jsonl'.length);
  if (!suffix || suffix === 'sessions') return null;
  return `agent:${agentId}:${suffix}`;
}

export function isSessionActivityOlderThanDays(activityMs: number, nowMs: number, minAgeDays: number): boolean {
  if (!activityMs || activityMs <= 0 || minAgeDays < 0) return false;
  const now = new Date(nowMs);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const daysAgo = (startOfToday - activityMs) / (24 * 60 * 60 * 1000);
  return daysAgo > minAgeDays;
}

function parseTranscriptMessageTimestamp(message: unknown): number | undefined {
  if (!message || typeof message !== 'object') return undefined;
  const timestamp = (message as { timestamp?: unknown }).timestamp;
  if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
    return timestamp < 1e12 ? timestamp * 1000 : timestamp;
  }
  if (typeof timestamp === 'string' && timestamp.trim()) {
    const parsed = Date.parse(timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function getMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (block && typeof block === 'object') {
          const text = (block as { text?: unknown }).text;
          return typeof text === 'string' ? text : '';
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function isInternalUserPreviewText(text: string): boolean {
  const normalized = text.trim();
  if (/^(HEARTBEAT_OK|NO_REPLY)\s*$/i.test(normalized)) return true;
  if (/^\[?OpenClaw heartbeat poll\]?\s*$/i.test(normalized)) return true;
  if (/^\[LYCLAW internal tool failure feedback\]/i.test(normalized)) return true;
  if (/^\[LYCLAW internal convergence directive\]/i.test(normalized)) return true;
  return false;
}

function cleanUserPreview(text: string): string {
  if (isInternalUserPreviewText(text)) return '';
  return text
    .replace(/^\[cron:[^\]]*\]?\s*/i, '')
    .replace(/\s*\[cron:[^\]]*\]?\s*/gi, ' ')
    .replace(/\s*\[media attached:[^\]]*\]/g, '')
    .replace(/\s*\[message_id:\s*[^\]]+\]/g, '')
    .replace(/\s*\[Working Directory:[^\]]*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SESSION_PREVIEW_MAX_CHARS);
}

async function readTranscriptPreview(filePath: string): Promise<{ firstUserMessagePreview?: string; lastMessageAt?: number }> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  let lineCount = 0;
  let firstUserMessagePreview: string | undefined;
  let lastMessageAt: number | undefined;

  try {
    for await (const line of reader) {
      lineCount += 1;
      if (!line.trim()) continue;

      try {
        const entry = JSON.parse(line) as { type?: string; message?: { role?: unknown; content?: unknown } };
        if (entry.type !== 'message' || !entry.message) continue;
        const timestamp = parseTranscriptMessageTimestamp(entry.message);
        if (timestamp) lastMessageAt = timestamp;
        if (!firstUserMessagePreview && entry.message.role === 'user') {
          const preview = cleanUserPreview(getMessageText(entry.message.content));
          if (preview) {
            firstUserMessagePreview = preview;
          }
        }
        if (firstUserMessagePreview && lineCount > SESSION_PREVIEW_MAX_LINES) break;
      } catch {
        // Ignore malformed transcript lines.
      }
    }
  } finally {
    reader.close();
    stream.destroy();
  }

  return { firstUserMessagePreview, lastMessageAt };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function collectIndexedTranscriptBasenames(sessionsJson: Record<string, unknown>): Set<string> {
  const indexed = new Set<string>();

  const addFileRef = (value: unknown) => {
    if (typeof value === 'string') {
      indexed.add(basename(value.endsWith('.jsonl') ? value : `${value}.jsonl`));
      return;
    }
    if (typeof value !== 'object' || value == null) return;
    const record = value as Record<string, unknown>;
    const fileInfo = record.file ?? record.fileName ?? record.path ?? record.sessionFile;
    if (typeof fileInfo === 'string') {
      indexed.add(basename(fileInfo.endsWith('.jsonl') ? fileInfo : `${fileInfo}.jsonl`));
    }
    const idValue = record.id ?? record.sessionId;
    if (typeof idValue === 'string') {
      indexed.add(basename(idValue.endsWith('.jsonl') ? idValue : `${idValue}.jsonl`));
    }
  };

  if (Array.isArray(sessionsJson.sessions)) {
    for (const entry of sessionsJson.sessions as Array<Record<string, unknown>>) {
      addFileRef(entry);
    }
  }

  for (const [key, value] of Object.entries(sessionsJson)) {
    if (key === 'sessions') continue;
    if (typeof value === 'string') {
      indexed.add(basename(value.endsWith('.jsonl') ? value : `${value}.jsonl`));
    } else {
      addFileRef(value);
    }
  }

  return indexed;
}

function collectIndexedSessionKeys(sessionsJson: Record<string, unknown>): Set<string> {
  const keys = new Set<string>();
  if (Array.isArray(sessionsJson.sessions)) {
    for (const entry of sessionsJson.sessions as Array<Record<string, unknown>>) {
      const key = entry.key ?? entry.sessionKey;
      if (typeof key === 'string') keys.add(key);
    }
  }
  for (const key of Object.keys(sessionsJson)) {
    if (key !== 'sessions') keys.add(key);
  }
  return keys;
}

async function buildRecoveryCacheSignature(sessionsDir: string): Promise<string> {
  let jsonlCount = 0;
  try {
    const entries = await readdir(sessionsDir);
    jsonlCount = entries.filter((name) => isOrphanTranscriptFileName(name)).length;
  } catch {
    return 'missing';
  }

  try {
    const sessionsJsonStat = await stat(join(sessionsDir, 'sessions.json'));
    return `${jsonlCount}:${sessionsJsonStat.mtimeMs}:${sessionsJsonStat.size}`;
  } catch {
    return `${jsonlCount}:no-sessions-json`;
  }
}

export async function listOrphanArchivedSessions(options: {
  sessionsDir: string;
  agentId: string;
  sessionsJson: Record<string, unknown> | null;
  minAgeDays?: number;
  nowMs?: number;
}): Promise<OrphanRecoveredSession[]> {
  const {
    sessionsDir,
    agentId,
    sessionsJson,
    minAgeDays = DEFAULT_MIN_AGE_DAYS,
    nowMs = Date.now(),
  } = options;

  const signature = await buildRecoveryCacheSignature(sessionsDir);
  const cacheKey = `${agentId}:${minAgeDays}`;
  const cached = orphanRecoveryCache.get(cacheKey);
  if (cached && cached.signature === signature) {
    return cached.sessions;
  }

  const indexedBasenames = sessionsJson ? collectIndexedTranscriptBasenames(sessionsJson) : new Set<string>();
  const indexedKeys = sessionsJson ? collectIndexedSessionKeys(sessionsJson) : new Set<string>();

  let dirEntries: string[];
  try {
    dirEntries = await readdir(sessionsDir);
  } catch {
    orphanRecoveryCache.set(cacheKey, { signature, sessions: [] });
    return [];
  }

  const orphanFiles = dirEntries.filter((name) => isOrphanTranscriptFileName(name) && !indexedBasenames.has(name));
  if (orphanFiles.length === 0) {
    orphanRecoveryCache.set(cacheKey, { signature, sessions: [] });
    return [];
  }

  const recovered = await mapWithConcurrency(orphanFiles, SESSION_PREVIEW_CONCURRENCY, async (fileName) => {
    const sessionKey = inferSessionKeyFromOrphanFile(agentId, fileName);
    if (!sessionKey || !isRecoverableOrphanSessionKey(sessionKey)) return null;
    if (indexedKeys.has(sessionKey)) return null;

    const filePath = join(sessionsDir, fileName);
    try {
      const preview = await readTranscriptPreview(filePath);
      if (!preview.firstUserMessagePreview) return null;
      if (!preview.lastMessageAt || !isSessionActivityOlderThanDays(preview.lastMessageAt, nowMs, minAgeDays)) {
        return null;
      }

      return {
        key: sessionKey,
        label: preview.firstUserMessagePreview,
        firstUserMessagePreview: preview.firstUserMessagePreview,
        lastMessageAt: preview.lastMessageAt,
        updatedAt: preview.lastMessageAt,
      } satisfies OrphanRecoveredSession;
    } catch (error) {
      logger.debug('[orphan-session-recovery] Failed to inspect orphan transcript', { fileName, error });
      return null;
    }
  });

  const sessions = recovered.filter((session): session is OrphanRecoveredSession => session != null);
  orphanRecoveryCache.set(cacheKey, { signature, sessions });
  logger.info(`[orphan-session-recovery] Recovered ${sessions.length} archived session(s) for agent ${agentId}`);
  return sessions;
}

export function clearOrphanRecoveryCacheForTests(): void {
  orphanRecoveryCache.clear();
}
