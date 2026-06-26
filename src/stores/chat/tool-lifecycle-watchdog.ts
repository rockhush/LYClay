import { invokeIpc } from '@/lib/api-client';
import type { ChatGet, ChatSet } from './store-api';
import type { ChatState, RawMessage, ToolLifecycleSnapshot, ToolStatus } from './types';

const DEFAULT_HARD_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_IDLE_TIMEOUT_MS = 90_000;

const watchdogTimers = new Map<string, ReturnType<typeof setTimeout>>();

function toolKey(sessionKey: string, runId: string | null, toolCallId: string): string {
  return `${sessionKey}::${runId ?? 'no-run'}::${toolCallId}`;
}

function nowSnapshot(snapshot: ToolLifecycleSnapshot, now = Date.now()): ToolLifecycleSnapshot {
  const idleMs = snapshot.lastProgressAt ? Math.max(0, now - snapshot.lastProgressAt) : null;
  return {
    ...snapshot,
    elapsedMs: Math.max(0, now - snapshot.startedAt),
    idleMs,
  };
}

function readTimeoutMs(name: string, fallback: number): number {
  const value = (globalThis as unknown as Record<string, unknown>)[name];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function getHardTimeoutMs(): number {
  return readTimeoutMs('__LYCLAW_TOOL_WATCHDOG_HARD_TIMEOUT_MS__', DEFAULT_HARD_TIMEOUT_MS);
}

function getIdleTimeoutMs(): number {
  return readTimeoutMs('__LYCLAW_TOOL_WATCHDOG_IDLE_TIMEOUT_MS__', DEFAULT_IDLE_TIMEOUT_MS);
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => {
    if (!block || typeof block !== 'object') return '';
    const record = block as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
    if (typeof record.content === 'string') return record.content;
    return '';
  }).filter(Boolean).join('\n');
}

function parseRunningHandle(text: string, details?: Record<string, unknown>): ToolLifecycleSnapshot['handle'] | undefined {
  const sessionId = typeof details?.sessionId === 'string' ? details.sessionId : undefined;
  const pid = typeof details?.pid === 'number' ? details.pid : undefined;
  if (sessionId) {
    return { kind: 'exec-session', id: sessionId, ...(pid ? { pid } : {}) };
  }

  const match = /\bsession\s+([A-Za-z0-9_-]+)(?:,\s*pid\s+(\d+))?/i.exec(text);
  if (!match) return undefined;
  const parsedPid = match[2] ? Number(match[2]) : undefined;
  return {
    kind: 'exec-session',
    id: match[1],
    ...(Number.isFinite(parsedPid) ? { pid: parsedPid } : {}),
  };
}

export function getRunningToolSnapshotFromMessage(
  message: RawMessage | undefined,
  context: { sessionKey: string; runId: string | null },
): ToolLifecycleSnapshot | null {
  if (!message || typeof message !== 'object') return null;
  const role = String(message.role ?? '').toLowerCase();
  if (role !== 'toolresult' && role !== 'tool_result') return null;

  const details = message.details && typeof message.details === 'object'
    ? message.details as Record<string, unknown>
    : undefined;
  const status = String((details?.status ?? (message as unknown as Record<string, unknown>).status) ?? '').toLowerCase();
  const outputText = typeof details?.aggregated === 'string'
    ? details.aggregated
    : extractText(message.content);
  const isRunning = status === 'running' || /command still running/i.test(outputText);
  if (!isRunning) return null;

  const now = Date.now();
  const hardTimeoutMs = getHardTimeoutMs();
  const idleTimeoutMs = getIdleTimeoutMs();
  const toolName = message.toolName || 'tool';
  const toolCallId = message.toolCallId || `${toolName}:${details?.sessionId ?? now}`;
  return {
    sessionKey: context.sessionKey,
    runId: context.runId,
    toolCallId,
    toolName,
    status: 'running',
    startedAt: now,
    lastProgressAt: now,
    timeoutAt: now + hardTimeoutMs,
    idleTimeoutAt: now + idleTimeoutMs,
    elapsedMs: 0,
    idleMs: 0,
    handle: parseRunningHandle(outputText, details),
    message: outputText || 'Tool is still running.',
  };
}

function upsertErrorToolStatus(tools: ToolStatus[], snapshot: ToolLifecycleSnapshot): ToolStatus[] {
  const key = snapshot.toolCallId;
  const update: ToolStatus = {
    id: key,
    toolCallId: key,
    name: snapshot.toolName,
    status: 'error',
    summary: snapshot.terminalReason === 'idle-timeout'
      ? 'Tool timed out after no progress.'
      : 'Tool timed out.',
    durationMs: snapshot.elapsedMs,
    updatedAt: Date.now(),
  };
  const index = tools.findIndex((tool) => (tool.toolCallId || tool.id || tool.name) === key);
  if (index === -1) return [...tools, update];
  const next = [...tools];
  next[index] = { ...next[index], ...update };
  return next;
}

function abortGatewayRun(snapshot: ToolLifecycleSnapshot): void {
  if (!snapshot.sessionKey) return;
  void invokeIpc(
    'gateway:rpc',
    'sessions.abort',
    {
      key: snapshot.sessionKey,
      ...(snapshot.runId ? { runId: snapshot.runId } : {}),
    },
    8_000,
  ).catch((error) => {
    console.warn('[tool-watchdog] Failed to abort run after tool timeout:', error);
  });
}

function settleTimedOutTool(set: ChatSet, get: ChatGet, key: string, reason: 'hard-timeout' | 'idle-timeout'): void {
  watchdogTimers.delete(key);
  const state = get();
  const foreground = state.activeTool && toolKey(state.activeTool.sessionKey, state.activeTool.runId, state.activeTool.toolCallId) === key
    ? state.activeTool
    : null;
  const backgroundEntry = foreground
    ? null
    : Object.entries(state.sessionStreamingStates).find(([, sessionState]) => (
      sessionState.activeTool
      && toolKey(sessionState.activeTool.sessionKey, sessionState.activeTool.runId, sessionState.activeTool.toolCallId) === key
    ));
  const snapshot = foreground ?? backgroundEntry?.[1].activeTool ?? null;
  if (!snapshot || snapshot.status !== 'running') return;

  const terminal = nowSnapshot({
    ...snapshot,
    status: 'timeout',
    terminalReason: reason,
  });
  abortGatewayRun(terminal);
  const error = reason === 'idle-timeout'
    ? `工具调用超时：${terminal.toolName} 长时间没有进展，本次运行已停止。`
    : `工具调用超时：${terminal.toolName} 运行时间过长，本次运行已停止。`;

  if (foreground) {
    set((s) => ({
      activeTool: terminal,
      runError: error,
      error: null,
      sending: false,
      activeRunId: null,
      streamingText: '',
      streamingMessage: null,
      pendingFinal: false,
      pendingToolImages: [],
      lastUserMessageAt: null,
      streamingTools: upsertErrorToolStatus(s.streamingTools, terminal),
    }));
    return;
  }

  if (backgroundEntry) {
    const [sessionKey, sessionState] = backgroundEntry;
    set((s) => ({
      sessionStreamingStates: {
        ...s.sessionStreamingStates,
        [sessionKey]: {
          ...sessionState,
          activeTool: terminal,
          runError: error,
          sending: false,
          activeRunId: null,
          streamingText: '',
          streamingMessage: null,
          pendingFinal: false,
          pendingToolImages: [],
          streamingTools: upsertErrorToolStatus(sessionState.streamingTools, terminal),
        },
      },
    }));
  }
}

function scheduleWatchdog(set: ChatSet, get: ChatGet, snapshot: ToolLifecycleSnapshot): void {
  const key = toolKey(snapshot.sessionKey, snapshot.runId, snapshot.toolCallId);
  const existing = watchdogTimers.get(key);
  if (existing) clearTimeout(existing);

  const nextDeadline = Math.min(
    snapshot.timeoutAt ?? Date.now() + getHardTimeoutMs(),
    snapshot.idleTimeoutAt ?? Date.now() + getIdleTimeoutMs(),
  );
  const delayMs = Math.max(1, nextDeadline - Date.now());
  const timer = setTimeout(() => {
    const current = get();
    const active = current.activeTool && toolKey(current.activeTool.sessionKey, current.activeTool.runId, current.activeTool.toolCallId) === key
      ? current.activeTool
      : Object.values(current.sessionStreamingStates)
        .map((sessionState) => sessionState.activeTool)
        .find((tool) => tool && toolKey(tool.sessionKey, tool.runId, tool.toolCallId) === key);
    if (!active || active.status !== 'running') {
      watchdogTimers.delete(key);
      return;
    }
    const now = Date.now();
    const reason = active.idleTimeoutAt && now >= active.idleTimeoutAt ? 'idle-timeout' : 'hard-timeout';
    settleTimedOutTool(set, get, key, reason);
  }, delayMs);
  watchdogTimers.set(key, timer);
}

export function trackRunningTool(set: ChatSet, get: ChatGet, snapshot: ToolLifecycleSnapshot, foreground: boolean): void {
  if (foreground) {
    set({ activeTool: snapshot });
  } else {
    set((s) => ({
      sessionStreamingStates: {
        ...s.sessionStreamingStates,
        [snapshot.sessionKey]: {
          ...(s.sessionStreamingStates[snapshot.sessionKey] ?? {
            activeRunId: snapshot.runId,
            activeTool: null,
            streamingText: '',
            streamingMessage: null,
            streamingTools: [],
            pendingFinal: false,
            lastUserMessageAt: null,
            pendingToolImages: [],
            runAborted: false,
            sending: true,
            runError: null,
            messagesSnapshot: [],
          }),
          activeTool: snapshot,
          activeRunId: snapshot.runId,
          sending: true,
        },
      },
    }));
  }
  scheduleWatchdog(set, get, snapshot);
}

export function clearToolWatchdog(snapshot: ToolLifecycleSnapshot | null | undefined): void {
  if (!snapshot) return;
  const key = toolKey(snapshot.sessionKey, snapshot.runId, snapshot.toolCallId);
  const timer = watchdogTimers.get(key);
  if (timer) clearTimeout(timer);
  watchdogTimers.delete(key);
}

export function clearToolWatchdogsForRun(set: ChatSet, get: ChatGet, runId: string | null, reason: ToolLifecycleSnapshot['terminalReason']): void {
  const state = get();
  const patch: Partial<ChatState> = {};
  const terminalStatus: ToolLifecycleSnapshot['status'] =
    reason === 'user-cancelled' || reason === 'run-aborted'
      ? 'cancelled'
      : reason === 'tool-error'
        ? 'failed'
        : 'completed';
  if (state.activeTool && (!runId || state.activeTool.runId === runId)) {
    clearToolWatchdog(state.activeTool);
    patch.activeTool = nowSnapshot({ ...state.activeTool, status: terminalStatus, terminalReason: reason });
  }
  const sessionEntries = Object.entries(state.sessionStreamingStates);
  const nextSessionStates: typeof state.sessionStreamingStates = {};
  let changed = false;
  for (const [sessionKey, sessionState] of sessionEntries) {
    if (sessionState.activeTool && (!runId || sessionState.activeTool.runId === runId)) {
      clearToolWatchdog(sessionState.activeTool);
      nextSessionStates[sessionKey] = {
        ...sessionState,
        activeTool: nowSnapshot({
          ...sessionState.activeTool,
          status: terminalStatus,
          terminalReason: reason,
        }),
      };
      changed = true;
    } else {
      nextSessionStates[sessionKey] = sessionState;
    }
  }
  if (changed) patch.sessionStreamingStates = nextSessionStates;
  if (Object.keys(patch).length > 0) {
    set(patch);
  }
}
