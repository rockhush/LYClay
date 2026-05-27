import type { IncomingMessage, ServerResponse } from 'http';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { listAgentsSnapshot } from '../../utils/agent-config';
import { getOpenClawConfigDir } from '../../utils/paths';
import { logger } from '../../utils/logger';
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

type TranscriptCache = FileSignature & {
  messages: unknown[];
};

const sessionFileIndexCache = new Map<string, SessionFileIndexCache>();
const transcriptCache = new Map<string, TranscriptCache>();

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

  const raw = await readFile(sessionsJsonPath, 'utf8');
  const sessionsJson = JSON.parse(raw) as Record<string, unknown>;
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

async function readTranscriptMessages(filePath: string): Promise<unknown[]> {
  let signature: FileSignature;
  try {
    const fileStat = await stat(filePath);
    signature = { mtimeMs: fileStat.mtimeMs, size: fileStat.size };
  } catch (error) {
    transcriptCache.delete(filePath);
    throw error;
  }

  const cached = transcriptCache.get(filePath);
  if (cached && sameSignature(cached, signature)) return cached.messages;

  const raw = await readFile(filePath, 'utf8');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const messages = lines.flatMap((line, idx) => {
    try {
      const entry = JSON.parse(line) as { type?: string; message?: unknown };
      return entry.type === 'message' && entry.message ? [entry.message] : [];
    } catch (err) {
      logger.warn(`[sessions:history-local] Failed to parse line ${idx}:`, err);
      return [];
    }
  });

  transcriptCache.set(filePath, { ...signature, messages });
  logger.debug(`[sessions:history-local] Parsed transcript ${filePath}, lines=${lines.length}, messages=${messages.length}`);
  return messages;
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
  return text
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

function resolveSessionFilePath(entry: Record<string, unknown>, sessionsDir: string): string | null {
  const fileValue = (entry.sessionFile ?? entry.file ?? entry.fileName ?? entry.path) as string | undefined;
  if (fileValue) {
    return isAbsolute(fileValue) ? fileValue : join(sessionsDir, fileValue.endsWith('.jsonl') ? fileValue : `${fileValue}.jsonl`);
  }

  const idValue = (entry.id ?? entry.sessionId) as string | undefined;
  if (!idValue) return null;
  return join(sessionsDir, idValue.endsWith('.jsonl') ? idValue : `${idValue}.jsonl`);
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

  return {
    key,
    label: firstUserMessagePreview ?? session.label,
    firstUserMessagePreview,
    displayName: session.displayName,
    thinkingLevel: session.thinkingLevel,
    model: session.model ?? defaultModel,
    updatedAt: session.updatedAt,
  };
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
      const fsP = await import('node:fs/promises');

      try {
        logger.info(`[sessions:list-local] Reading ${sessionsJsonPath}`);
        const raw = await fsP.readFile(sessionsJsonPath, 'utf8');
        const sessionsJson = JSON.parse(raw) as Record<string, unknown>;
        
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
              const firstUserMessagePreview = await readFirstUserPreview(sessionFilePath);
              if (!firstUserMessagePreview) return session;
              return {
                ...session,
                firstUserMessagePreview,
                label: session.label || firstUserMessagePreview,
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
      const index = await getSessionFileIndex(agentId, sessionsJsonPath);
      const fileInfo = index?.filesBySessionKey.get(sessionKey);
      let resolvedSrcPath = fileInfo?.resolvedPath;
      let uuidFileName = fileInfo?.fileName;

      if (!uuidFileName && !resolvedSrcPath) {
        logger.warn(`[sessions:history-local] No UUID file found for ${sessionKey}`);
        sendJson(res, 200, { success: true, messages: [] });
        return true;
      }

      if (!resolvedSrcPath) {
        if (!uuidFileName!.endsWith('.jsonl')) uuidFileName = `${uuidFileName}.jsonl`;
        resolvedSrcPath = join(sessionsDir, uuidFileName!);
      }

      let messages: unknown[] = [];
      let promptErrors: PromptErrorRecord[] = [];

      try {
        const raw = await fsP.readFile(resolvedSrcPath, 'utf8');
        logger.info(`[sessions:history-local] File read successfully, size: ${raw.length} bytes`);

        const lines = raw.split(/\r?\n/).filter(Boolean);
        logger.info(`[sessions:history-local] Found ${lines.length} lines`);

        const parsed = lines.flatMap((line, idx) => {
          try {
            const entry = JSON.parse(line) as {
              type?: string;
              customType?: string;
              message?: unknown;
              data?: PromptErrorRecord;
            };
            if (entry.type === 'message' && entry.message) {
              return [{ kind: 'message' as const, value: entry.message }];
            }
            if (entry.type === 'custom' && entry.customType === 'openclaw:prompt-error') {
              return [{ kind: 'promptError' as const, value: entry.data ?? {} }];
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
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
          logger.warn(`[sessions:history-local] File not found: ${resolvedSrcPath}`);
        } else {
          logger.error(`[sessions:history-local] Error reading file:`, error);
        }
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
          return entry.type === 'message' && entry.message ? [entry.message] : [];
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
      const raw = await fsP.readFile(sessionsJsonPath, 'utf8');
      const sessionsJson = JSON.parse(raw) as Record<string, unknown>;

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
      const raw2 = await fsP.readFile(sessionsJsonPath, 'utf8');
      const json2 = JSON.parse(raw2) as Record<string, unknown>;
      if (Array.isArray(json2.sessions)) {
        json2.sessions = (json2.sessions as Array<Record<string, unknown>>)
          .filter((s) => s.key !== sessionKey && s.sessionKey !== sessionKey);
      } else if (json2[sessionKey]) {
        delete json2[sessionKey];
      }
      await fsP.writeFile(sessionsJsonPath, JSON.stringify(json2, null, 2), 'utf8');
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  return false;
}
