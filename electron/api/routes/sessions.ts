import type { IncomingMessage, ServerResponse } from 'http';
import { createReadStream } from 'node:fs';
import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { listAgentsSnapshot } from '../../utils/agent-config';
import { getOpenClawConfigDir } from '../../utils/paths';
import { logger } from '../../utils/logger';
import { redactSecrets, redactStructuredSecrets } from '../../security/secret-scanner';
import { sanitizeTranscriptMessageForDisplay } from '../../utils/silent-reply-sanitize';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';

const SAFE_SESSION_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const SESSION_PREVIEW_MAX_LINES = 40;
const SESSION_PREVIEW_MAX_CHARS = 80;
const SESSION_PREVIEW_CONCURRENCY = 4;
const HISTORY_LOCAL_SLOW_MS = 500;

type FileSignature = {
  mtimeMs: number;
  size: number;
};

type SessionFileIndexCache = FileSignature & {
  filesBySessionKey: Map<string, { fileName?: string; resolvedPath?: string }>;
};

const sessionFileIndexCache = new Map<string, SessionFileIndexCache>();
const transcriptCache = new Map<string, TranscriptCache>();
const SESSIONS_JSON_READ_RETRY_DELAYS_MS = [30, 80, 150];

type ReadSessionsJsonOptions = {
  label: string;
  allowMissing?: boolean;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientReadError(error: unknown): boolean {
  const code = getErrorCode(error);
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
}

async function readSessionsJsonSafe(
  sessionsJsonPath: string,
  options: ReadSessionsJsonOptions,
): Promise<Record<string, unknown> | null> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= SESSIONS_JSON_READ_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const raw = await readFile(sessionsJsonPath, 'utf8');
      if (!raw.trim()) return {};
      return JSON.parse(raw) as Record<string, unknown>;
    } catch (error) {
      lastError = error;
      const code = getErrorCode(error);
      if (code === 'ENOENT' && options.allowMissing) return null;
      const retryable = isTransientReadError(error) || error instanceof SyntaxError;
      if (!retryable || attempt >= SESSIONS_JSON_READ_RETRY_DELAYS_MS.length) break;
      await sleep(SESSIONS_JSON_READ_RETRY_DELAYS_MS[attempt]!);
    }
  }

  logger.warn(`[${options.label}] Could not read valid sessions.json at ${sessionsJsonPath}:`, lastError);
  return null;
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const tempPath = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(tempPath, JSON.stringify(value, null, 2), 'utf8');
    await rename(tempPath, filePath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

function sameSignature(a: FileSignature, b: FileSignature): boolean {
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function getSessionEntryFileInfo(
  entry: Record<string, unknown>,
  options?: { preferId?: boolean },
): { fileName?: string; resolvedPath?: string } {
  let fileName = (entry.file ?? entry.fileName ?? entry.path) as string | undefined;
  const resolvedPath = entry.sessionFile as string | undefined;
  const uuidVal = (entry.id ?? entry.sessionId) as string | undefined;
  if (uuidVal && (options?.preferId || !fileName)) {
    fileName = uuidVal.endsWith('.jsonl') ? uuidVal : `${uuidVal}.jsonl`;
  }
  return { fileName, resolvedPath };
}

async function getSessionFileIndex(agentId: string, sessionsJsonPath: string): Promise<SessionFileIndexCache | null> {
  let signature: FileSignature;
  try {
    const fileStat = await stat(sessionsJsonPath);
    signature = { mtimeMs: fileStat.mtimeMs, size: fileStat.size };
  } catch (error) {
    if (getErrorCode(error) !== 'ENOENT') {
      logger.warn('[sessions:history-local] Could not stat sessions.json:', error);
    }
    sessionFileIndexCache.delete(agentId);
    return null;
  }

  const cached = sessionFileIndexCache.get(agentId);
  if (cached && sameSignature(cached, signature)) return cached;

  const sessionsJson = await readSessionsJsonSafe(sessionsJsonPath, {
    label: 'sessions:history-local',
    allowMissing: true,
  });
  if (!sessionsJson) {
    sessionFileIndexCache.delete(agentId);
    return null;
  }
  const filesBySessionKey = new Map<string, { fileName?: string; resolvedPath?: string }>();

  if (Array.isArray(sessionsJson.sessions)) {
    for (const entry of sessionsJson.sessions as Array<Record<string, unknown>>) {
      const key = entry.key ?? entry.sessionKey;
      if (typeof key === 'string') {
        filesBySessionKey.set(key, getSessionEntryFileInfo(entry));
      }
    }
  }

  for (const [key, value] of Object.entries(sessionsJson)) {
    if (key === 'sessions') continue;
    if (typeof value === 'string') {
      filesBySessionKey.set(key, { fileName: value });
    } else if (typeof value === 'object' && value !== null) {
      filesBySessionKey.set(key, getSessionEntryFileInfo(value as Record<string, unknown>, { preferId: true }));
    }
  }

  const next = { ...signature, filesBySessionKey };
  sessionFileIndexCache.set(agentId, next);
  logger.debug(`[sessions:history-local] Parsed sessions.json for ${agentId}, entries=${filesBySessionKey.size}`);
  return next;
}

type PromptErrorRecord = {
  timestamp?: unknown;
  runId?: unknown;
  error?: unknown;
};

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

function cleanUserPreview(text: string): string {
  if (isInternalUserPreviewText(text)) return '';
  return redactSecrets(text)
    .replace(/\s*\[media attached:[^\]]*\]/g, '')
    .replace(/\s*\[message_id:\s*[^\]]+\]/g, '')
    .replace(/\s*\[Working Directory:[^\]]*\]/g, '')
    .replace(/Sender\s*\([^)]*\):\s*```[a-z]*\n[\s\S]*?```\s*/gi, '')
    .replace(/Sender\s*\([^)]*\):\s*\{[\s\S]*?\}\s*/gi, '')
    .replace(/Conversation info\s*\([^)]*\):\s*```[a-z]*\n[\s\S]*?```\s*/gi, '')
    .replace(/Conversation info\s*\([^)]*\):\s*\{[\s\S]*?\}\s*/gi, '')
    .replace(/\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+[^\]]+\]\s*/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SESSION_PREVIEW_MAX_CHARS);
}

function isInternalUserPreviewText(text: string): boolean {
  const normalized = text.trim();
  if (/^(HEARTBEAT_OK|NO_REPLY)\s*$/i.test(normalized)) return true;
  if (/^\[?OpenClaw heartbeat poll\]?\s*$/i.test(normalized)) return true;
  if (/^\[LYCLAW internal tool failure feedback\]/i.test(normalized)) return true;
  if (/^\[LYCLAW internal convergence directive\]/i.test(normalized)) return true;
  if (
    /^\s*Current time\s*:/i.test(normalized)
    && /^\s*Current time\s*:[^\n]*\/\s*\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+UTC\s*$/i.test(normalized)
  ) {
    return true;
  }
  return false;
}

function resolveSessionFilePath(entry: Record<string, unknown>, sessionsDir: string): string | null {
  const fileValue = (entry.sessionFile ?? entry.file ?? entry.fileName ?? entry.path) as string | undefined;
  if (fileValue) {
    return isAbsolute(fileValue) ? fileValue : join(sessionsDir, fileValue.endsWith('.jsonl') ? fileValue : `${fileValue}.jsonl`);
  }

  const idValue = (entry.id ?? entry.sessionId) as string | undefined;
  if (!idValue) return null;
  return join(sessionsDir, idValue.endsWith('.jsonl') ? idValue : `${idValue}.jsonl`);
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

function mergeTranscriptEntryTimestamp(message: unknown, entryTimestamp?: string): unknown {
  let ms = parseTranscriptMessageTimestamp(message);
  if (!ms && typeof entryTimestamp === 'string' && entryTimestamp.trim()) {
    const parsed = Date.parse(entryTimestamp.trim());
    if (Number.isFinite(parsed)) ms = parsed;
  }
  if (!ms) return message;

  const record = message && typeof message === 'object'
    ? { ...(message as Record<string, unknown>) }
    : { content: message };
  record.timestamp = ms / 1000;
  return record;
}

async function readLastMessageTimestamp(filePath: string): Promise<number | undefined> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  let lastTimestamp: number | undefined;

  try {
    for await (const line of reader) {
      if (!line.trim()) continue;

      try {
        const entry = JSON.parse(line) as { type?: string; message?: unknown };
        if (entry.type !== 'message' || !entry.message) continue;
        const timestamp = parseTranscriptMessageTimestamp(entry.message);
        if (timestamp) lastTimestamp = timestamp;
      } catch {
        // Ignore malformed transcript lines; history loading has its own parser/logs.
      }
    }
  } finally {
    reader.close();
    stream.destroy();
  }

  return lastTimestamp;
}

async function readFirstUserPreview(filePath: string): Promise<string | undefined> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  let lineCount = 0;

  try {
    for await (const line of reader) {
      lineCount += 1;
      if (lineCount > SESSION_PREVIEW_MAX_LINES) break;
      if (!line.trim()) continue;

      try {
        const entry = JSON.parse(line) as { type?: string; message?: { role?: unknown; content?: unknown } };
        if (entry.type !== 'message' || entry.message?.role !== 'user') continue;
        const preview = cleanUserPreview(getMessageText(entry.message.content));
        if (preview) return preview;
      } catch {
        // Ignore malformed transcript lines; history loading has its own parser/logs.
      }
    }
  } finally {
    reader.close();
    stream.destroy();
  }

  return undefined;
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

function toPublicSessionListItem(session: Record<string, unknown>, defaultModel?: string): Record<string, unknown> {
  const key = session.key ?? session.sessionKey;
  const firstUserMessagePreview = session.firstUserMessagePreview;

  return redactStructuredSecrets({
    key,
    label: firstUserMessagePreview ?? session.label,
    firstUserMessagePreview,
    displayName: session.displayName,
    thinkingLevel: session.thinkingLevel,
    model: session.model ?? defaultModel,
    updatedAt: session.updatedAt,
    lastMessageAt: session.lastMessageAt,
  }) as Record<string, unknown>;
}

export async function handleSessionRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  _ctx: HostApiContext,
): Promise<boolean> {
  // 新增：直接从本地文件系统读取会话列表
  if (url.pathname === '/api/sessions/list-local' && req.method === 'GET') {
    try {
      const agentId = url.searchParams.get('agentId')?.trim() || 'main';
      const includePreviews = url.searchParams.get('includePreviews') === '1';
      if (!SAFE_SESSION_SEGMENT.test(agentId)) {
        sendJson(res, 400, { success: false, error: 'Invalid agentId' });
        return true;
      }

      const sessionsDir = join(getOpenClawConfigDir(), 'agents', agentId, 'sessions');
      const sessionsJsonPath = join(sessionsDir, 'sessions.json');

      try {
        logger.info(`[sessions:list-local] Reading ${sessionsJsonPath}`);
        const sessionsJson = await readSessionsJsonSafe(sessionsJsonPath, {
          label: 'sessions:list-local',
          allowMissing: true,
        });
        if (!sessionsJson) {
          logger.warn(`[sessions:list-local] sessions.json not found or invalid at ${sessionsJsonPath}`);
          sendJson(res, 200, { success: true, sessions: [] });
          return true;
        }

        logger.info(`[sessions:list-local] Parsed sessions.json, keys: ${Object.keys(sessionsJson).join(', ')}`);
        
        let sessions: Array<Record<string, unknown>> = [];
        
        // 支持两种格式
        if (Array.isArray(sessionsJson.sessions)) {
          sessions = sessionsJson.sessions as Array<Record<string, unknown>>;
          logger.info(`[sessions:list-local] Found array format with ${sessions.length} sessions`);
        } else {
          // 对象格式：{ "sessionKey": { ... } }
          sessions = Object.entries(sessionsJson)
            .filter(([key]) => key !== 'sessions')
            .map(([key, value]) => {
              if (typeof value === 'object' && value !== null) {
                return { key, ...(value as Record<string, unknown>) };
              }
              return { key };
            });
          logger.info(`[sessions:list-local] Found object format with ${sessions.length} sessions`);
        }
        
        if (includePreviews && sessions.length > 0) {
          const previewStart = Date.now();
          sessions = await mapWithConcurrency(sessions, SESSION_PREVIEW_CONCURRENCY, async (session) => {
            const sessionFilePath = resolveSessionFilePath(session, sessionsDir);
            if (!sessionFilePath) return session;

            try {
              const [firstUserMessagePreview, lastMessageAt] = await Promise.all([
                readFirstUserPreview(sessionFilePath),
                readLastMessageTimestamp(sessionFilePath),
              ]);
              if (!firstUserMessagePreview && !lastMessageAt) return session;
              return {
                ...session,
                ...(firstUserMessagePreview
                  ? {
                    firstUserMessagePreview,
                    label: session.label || firstUserMessagePreview,
                  }
                  : {}),
                ...(lastMessageAt ? { lastMessageAt } : {}),
              };
            } catch {
              return session;
            }
          });
          logger.info(`[sessions:list-local] Extracted previews for ${sessions.length} sessions in ${Date.now() - previewStart}ms`);
        }
        
        const agentsSnapshot = await listAgentsSnapshot();
        const defaultSessionModel = agentsSnapshot.agents.find((agent) => agent.id === agentId)?.modelDisplay
          || agentsSnapshot.defaultModelRef
          || undefined;
        const publicSessions = sessions.map((session) => toPublicSessionListItem(session, defaultSessionModel)).filter((session) => session.key);
        logger.info(`[sessions:list-local] Returning ${publicSessions.length} sessions`);
        sendJson(res, 200, { success: true, sessions: publicSessions });
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
          // sessions.json 不存在，返回空列表
          logger.warn(`[sessions:list-local] sessions.json not found at ${sessionsJsonPath}`);
          sendJson(res, 200, { success: true, sessions: [] });
        } else {
          logger.error(`[sessions:list-local] Error reading sessions.json:`, error);
          throw error;
        }
      }
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  // 新增：直接从本地文件系统读取历史消息
  if (url.pathname === '/api/sessions/history-local' && req.method === 'GET') {
    const requestStart = Date.now();
    try {
      const fsP = await import('node:fs/promises');
      const sessionKey = url.searchParams.get('sessionKey')?.trim() || '';
      logger.debug(`[sessions:history-local] Request for sessionKey: ${sessionKey}`);

      if (!sessionKey || !sessionKey.startsWith('agent:')) {
        sendJson(res, 400, { success: false, error: 'Invalid sessionKey' });
        return true;
      }

      const parts = sessionKey.split(':');
      if (parts.length < 3) {
        sendJson(res, 400, { success: false, error: 'sessionKey has too few parts' });
        return true;
      }

      const agentId = parts[1];

      if (!SAFE_SESSION_SEGMENT.test(agentId)) {
        sendJson(res, 400, { success: false, error: 'Invalid agentId' });
        return true;
      }

      const sessionsDir = join(getOpenClawConfigDir(), 'agents', agentId, 'sessions');
      const sessionsJsonPath = join(sessionsDir, 'sessions.json');
      const sessionSegment = parts.slice(2).join(':');
      const sessionKeyFallbackPath = sessionSegment.startsWith('session-')
        ? join(sessionsDir, `${sessionSegment}.jsonl`)
        : null;
      const index = await getSessionFileIndex(agentId, sessionsJsonPath);
      const fileInfo = index?.filesBySessionKey.get(sessionKey);
      let resolvedSrcPath = fileInfo?.resolvedPath;
      let uuidFileName = fileInfo?.fileName;

      if (!uuidFileName && !resolvedSrcPath) {
        if (sessionKeyFallbackPath) {
          try {
            await fsP.access(sessionKeyFallbackPath);
            resolvedSrcPath = sessionKeyFallbackPath;
            uuidFileName = `${sessionSegment}.jsonl`;
            logger.debug(`[sessions:history-local] Using sessionKey fallback path: ${sessionKeyFallbackPath}`);
          } catch {
            logger.warn(`[sessions:history-local] No UUID file found for ${sessionKey}`);
            sendJson(res, 200, { success: true, messages: [] });
            return true;
          }
        } else {
          logger.warn(`[sessions:history-local] No UUID file found for ${sessionKey}`);
          sendJson(res, 200, { success: true, messages: [] });
          return true;
        }
      }

      if (!resolvedSrcPath) {
        if (!uuidFileName!.endsWith('.jsonl')) uuidFileName = `${uuidFileName}.jsonl`;
        resolvedSrcPath = join(sessionsDir, uuidFileName!);
      }

      let messages: unknown[] = [];
      let promptErrors: PromptErrorRecord[] = [];

      let raw: string | null = null;
      try {
        raw = await fsP.readFile(resolvedSrcPath, 'utf8');
      } catch (error) {
        const canUseSessionKeyFallback = getErrorCode(error) === 'ENOENT'
          && sessionKeyFallbackPath
          && sessionKeyFallbackPath !== resolvedSrcPath;
        if (canUseSessionKeyFallback) {
          try {
            raw = await fsP.readFile(sessionKeyFallbackPath, 'utf8');
            resolvedSrcPath = sessionKeyFallbackPath;
            logger.debug(
              `[sessions:history-local] Indexed path missing, using sessionKey fallback: ${sessionKeyFallbackPath}`,
            );
          } catch (fallbackError) {
            if (getErrorCode(fallbackError) === 'ENOENT') {
              logger.warn(`[sessions:history-local] File not found: ${resolvedSrcPath}`);
            } else {
              logger.error(`[sessions:history-local] Error reading sessionKey fallback file:`, fallbackError);
            }
          }
        } else if (getErrorCode(error) === 'ENOENT') {
          logger.warn(`[sessions:history-local] File not found: ${resolvedSrcPath}`);
        } else {
          logger.error(`[sessions:history-local] Error reading file:`, error);
        }
      }

      if (raw != null) {
        logger.info(`[sessions:history-local] File read successfully, size: ${raw.length} bytes`);

        const lines = raw.split(/\r?\n/).filter(Boolean);
        logger.info(`[sessions:history-local] Found ${lines.length} lines`);

        const parsed = lines.flatMap((line, idx): Array<{
          kind: 'message' | 'promptError';
          value: unknown;
        }> => {
          try {
            const entry = JSON.parse(line) as {
              type?: string;
              customType?: string;
              timestamp?: string;
              message?: unknown;
              data?: PromptErrorRecord;
            };
            if (entry.type === 'message' && entry.message) {
              const message = redactStructuredSecrets(sanitizeTranscriptMessageForDisplay(entry.message));
              const withTimestamp = mergeTranscriptEntryTimestamp(message, entry.timestamp);
              return [{ kind: 'message' as const, value: withTimestamp }];
            }
            if (entry.type === 'custom' && entry.customType === 'openclaw:prompt-error') {
              return [{ kind: 'promptError' as const, value: redactStructuredSecrets(entry.data ?? {}) }];
            }
            return [];
          } catch (err) {
            logger.warn(`[sessions:history-local] Failed to parse line ${idx}:`, err);
            return [];
          }
        });
        messages = parsed
          .filter((entry) => entry.kind === 'message')
          .map((entry) => entry.value);
        promptErrors = parsed
          .filter((entry) => entry.kind === 'promptError')
          .map((entry) => entry.value as PromptErrorRecord);

        logger.info(`[sessions:history-local] Extracted ${messages.length} messages and ${promptErrors.length} prompt errors`);
      }

      const durationMs = Date.now() - requestStart;
      if (durationMs >= HISTORY_LOCAL_SLOW_MS) {
        logger.info(`[sessions:history-local] Returning ${messages.length} messages in ${durationMs}ms`);
      } else {
        logger.debug(`[sessions:history-local] Returning ${messages.length} messages in ${durationMs}ms`);
      }

      logger.info(`[sessions:history-local] Returning ${messages.length} messages`);
      sendJson(res, 200, { success: true, messages, promptErrors });
    } catch (error) {
      const { logger } = await import('../../utils/logger');
      logger.error(`[sessions:history-local] Fatal error:`, error);
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/sessions/transcript' && req.method === 'GET') {
    try {
      const agentId = url.searchParams.get('agentId')?.trim() || '';
      const sessionId = url.searchParams.get('sessionId')?.trim() || '';
      if (!agentId || !sessionId) {
        sendJson(res, 400, { success: false, error: 'agentId and sessionId are required' });
        return true;
      }
      if (!SAFE_SESSION_SEGMENT.test(agentId) || !SAFE_SESSION_SEGMENT.test(sessionId)) {
        sendJson(res, 400, { success: false, error: 'Invalid transcript identifier' });
        return true;
      }

      const transcriptPath = join(getOpenClawConfigDir(), 'agents', agentId, 'sessions', `${sessionId}.jsonl`);
      const fsP = await import('node:fs/promises');
      const raw = await fsP.readFile(transcriptPath, 'utf8');
      const lines = raw.split(/\r?\n/).filter(Boolean);
      const messages = lines.flatMap((line) => {
        try {
          const entry = JSON.parse(line) as { type?: string; message?: unknown };
          return entry.type === 'message' && entry.message ? [redactStructuredSecrets(entry.message)] : [];
        } catch {
          return [];
        }
      });

      sendJson(res, 200, { success: true, messages });
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
        sendJson(res, 404, { success: false, error: 'Transcript not found' });
      } else {
        sendJson(res, 500, { success: false, error: 'Failed to load transcript' });
      }
    }
    return true;
  }

  if (url.pathname === '/api/sessions/delete' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ sessionKey: string }>(req);
      const sessionKey = body.sessionKey;
      if (!sessionKey || !sessionKey.startsWith('agent:')) {
        sendJson(res, 400, { success: false, error: `Invalid sessionKey: ${sessionKey}` });
        return true;
      }
      const parts = sessionKey.split(':');
      if (parts.length < 3) {
        sendJson(res, 400, { success: false, error: `sessionKey has too few parts: ${sessionKey}` });
        return true;
      }
      const agentId = parts[1];
      const sessionsDir = join(getOpenClawConfigDir(), 'agents', agentId, 'sessions');
      const sessionsJsonPath = join(sessionsDir, 'sessions.json');
      const fsP = await import('node:fs/promises');
      const sessionsJson = await readSessionsJsonSafe(sessionsJsonPath, {
        label: 'sessions:delete',
        allowMissing: false,
      });
      if (!sessionsJson) {
        sendJson(res, 409, { success: false, error: 'sessions.json is temporarily unavailable or invalid' });
        return true;
      }

      let uuidFileName: string | undefined;
      let resolvedSrcPath: string | undefined;
      if (Array.isArray(sessionsJson.sessions)) {
        const entry = (sessionsJson.sessions as Array<Record<string, unknown>>)
          .find((s) => s.key === sessionKey || s.sessionKey === sessionKey);
        if (entry) {
          uuidFileName = (entry.file ?? entry.fileName ?? entry.path) as string | undefined;
          if (!uuidFileName && typeof entry.id === 'string') {
            uuidFileName = `${entry.id}.jsonl`;
          }
        }
      }
      if (!uuidFileName && sessionsJson[sessionKey] != null) {
        const val = sessionsJson[sessionKey];
        if (typeof val === 'string') {
          uuidFileName = val;
        } else if (typeof val === 'object' && val !== null) {
          const entry = val as Record<string, unknown>;
          const absFile = (entry.sessionFile ?? entry.file ?? entry.fileName ?? entry.path) as string | undefined;
          if (absFile) {
            if (absFile.startsWith('/') || absFile.match(/^[A-Za-z]:\\/)) {
              resolvedSrcPath = absFile;
            } else {
              uuidFileName = absFile;
            }
          } else {
            const uuidVal = (entry.id ?? entry.sessionId) as string | undefined;
            if (uuidVal) uuidFileName = uuidVal.endsWith('.jsonl') ? uuidVal : `${uuidVal}.jsonl`;
          }
        }
      }
      if (!uuidFileName && !resolvedSrcPath) {
        sendJson(res, 404, { success: false, error: `Cannot resolve file for session: ${sessionKey}` });
        return true;
      }
      if (!resolvedSrcPath) {
        if (!uuidFileName!.endsWith('.jsonl')) uuidFileName = `${uuidFileName}.jsonl`;
        resolvedSrcPath = join(sessionsDir, uuidFileName!);
      }
      const dstPath = resolvedSrcPath.replace(/\.jsonl$/, '.deleted.jsonl');
      try {
        await fsP.access(resolvedSrcPath);
        await fsP.rename(resolvedSrcPath, dstPath);
      } catch {
        // Non-fatal; still try to update sessions.json.
      }
      const json2 = await readSessionsJsonSafe(sessionsJsonPath, {
        label: 'sessions:delete',
        allowMissing: false,
      });
      if (!json2) {
        sendJson(res, 409, { success: false, error: 'sessions.json is temporarily unavailable or invalid' });
        return true;
      }
      if (Array.isArray(json2.sessions)) {
        json2.sessions = (json2.sessions as Array<Record<string, unknown>>)
          .filter((s) => s.key !== sessionKey && s.sessionKey !== sessionKey);
      } else if (json2[sessionKey]) {
        delete json2[sessionKey];
      }
      await writeJsonAtomic(sessionsJsonPath, json2);
      sessionFileIndexCache.delete(agentId);
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  return false;
}
