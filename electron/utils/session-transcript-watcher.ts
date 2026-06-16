import { existsSync, watch, type FSWatcher } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, normalize } from 'node:path';
import type { BrowserWindow } from 'electron';
import type { HostEventBus } from '../api/event-bus';
import { logger } from './logger';
import { getOpenClawConfigDir } from './paths';

export type SessionTranscriptUpdatePayload = {
  agentId?: string;
  sessionKey?: string;
  fileName?: string;
  reason: 'sessions-json' | 'transcript';
  changedAt: number;
};

type WatcherHandle = {
  stop: () => void;
};

const WATCH_RESCAN_INTERVAL_MS = 10_000;
const EMIT_DEBOUNCE_MS = 300;

function isSessionFile(fileName: string): boolean {
  return fileName === 'sessions.json' || fileName.endsWith('.jsonl');
}

function normalizeFileName(fileName: string): string {
  return fileName.endsWith('.jsonl') ? fileName : `${fileName}.jsonl`;
}

function getSessionEntryFileName(entry: Record<string, unknown>): string | null {
  const direct = entry.file ?? entry.fileName ?? entry.path;
  if (typeof direct === 'string' && direct.trim()) {
    return basename(normalizeFileName(direct.trim()));
  }
  const id = entry.id ?? entry.sessionId;
  return typeof id === 'string' && id.trim()
    ? basename(normalizeFileName(id.trim()))
    : null;
}

async function resolveSessionKeyForFile(agentId: string, fileName: string): Promise<string | undefined> {
  if (fileName === 'sessions.json') return undefined;
  const sessionsJsonPath = join(getOpenClawConfigDir(), 'agents', agentId, 'sessions', 'sessions.json');
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await readFile(sessionsJsonPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }

  const target = basename(fileName);
  if (Array.isArray(parsed.sessions)) {
    for (const entry of parsed.sessions as Array<Record<string, unknown>>) {
      const key = entry.key ?? entry.sessionKey;
      if (typeof key !== 'string') continue;
      if (getSessionEntryFileName(entry) === target) return key;
    }
  }

  for (const [key, value] of Object.entries(parsed)) {
    if (key === 'sessions') continue;
    if (typeof value === 'string') {
      if (basename(normalizeFileName(value)) === target) return key;
    } else if (value && typeof value === 'object') {
      if (getSessionEntryFileName(value as Record<string, unknown>) === target) return key;
    }
  }

  return undefined;
}

export function startSessionTranscriptWatcher(options: {
  eventBus: HostEventBus;
  getMainWindow: () => BrowserWindow | null;
}): WatcherHandle {
  const agentsDir = join(getOpenClawConfigDir(), 'agents');
  const watchers = new Map<string, FSWatcher>();
  const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let stopped = false;
  let rescanTimer: ReturnType<typeof setInterval> | null = null;

  const emitUpdate = (payload: SessionTranscriptUpdatePayload) => {
    options.eventBus.emit('session:updated', payload);
    const win = options.getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('session:updated', payload);
    }
  };

  const scheduleUpdate = (agentId: string, fileName: string) => {
    if (!isSessionFile(fileName)) return;
    const debounceKey = `${agentId}:${fileName}`;
    const existing = pendingTimers.get(debounceKey);
    if (existing) clearTimeout(existing);

    pendingTimers.set(debounceKey, setTimeout(() => {
      pendingTimers.delete(debounceKey);
      void resolveSessionKeyForFile(agentId, fileName)
        .then((sessionKey) => {
          emitUpdate({
            agentId,
            sessionKey,
            fileName,
            reason: fileName === 'sessions.json' ? 'sessions-json' : 'transcript',
            changedAt: Date.now(),
          });
        })
        .catch((error) => {
          logger.debug('[session-transcript-watcher] failed to resolve session key:', error);
          emitUpdate({
            agentId,
            fileName,
            reason: fileName === 'sessions.json' ? 'sessions-json' : 'transcript',
            changedAt: Date.now(),
          });
        });
    }, EMIT_DEBOUNCE_MS));
  };

  const watchSessionsDir = (agentId: string, sessionsDir: string) => {
    const normalizedDir = normalize(sessionsDir);
    if (watchers.has(normalizedDir)) return;

    try {
      const watcher = watch(sessionsDir, { persistent: false }, (_eventType, rawFileName) => {
        if (!rawFileName) return;
        scheduleUpdate(agentId, String(rawFileName));
      });
      watcher.on('error', (error) => {
        logger.debug(`[session-transcript-watcher] watcher error for ${sessionsDir}:`, error);
      });
      watchers.set(normalizedDir, watcher);
      logger.debug(`[session-transcript-watcher] watching ${sessionsDir}`);
    } catch (error) {
      logger.debug(`[session-transcript-watcher] could not watch ${sessionsDir}:`, error);
    }
  };

  const scanAgentSessionDirs = async () => {
    if (stopped || !existsSync(agentsDir)) return;
    let entries: Array<{ name: string; isDirectory: () => boolean }>;
    try {
      entries = await readdir(agentsDir, { withFileTypes: true });
    } catch (error) {
      logger.debug('[session-transcript-watcher] failed to scan agents dir:', error);
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sessionsDir = join(agentsDir, entry.name, 'sessions');
      try {
        const info = await stat(sessionsDir);
        if (info.isDirectory()) watchSessionsDir(entry.name, sessionsDir);
      } catch {
        // Agent may not have a sessions directory yet.
      }
    }
  };

  void scanAgentSessionDirs();
  rescanTimer = setInterval(() => {
    void scanAgentSessionDirs();
  }, WATCH_RESCAN_INTERVAL_MS);
  rescanTimer.unref?.();

  return {
    stop: () => {
      stopped = true;
      if (rescanTimer) clearInterval(rescanTimer);
      for (const timer of pendingTimers.values()) clearTimeout(timer);
      pendingTimers.clear();
      for (const watcher of watchers.values()) {
        try {
          watcher.close();
        } catch {
          // Ignore close failures during app shutdown.
        }
      }
      watchers.clear();
    },
  };
}
