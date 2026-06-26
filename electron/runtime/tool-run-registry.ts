import { logger } from '../utils/logger';

export type ToolRunOwner = 'user-run' | 'internal-heartbeat' | 'recovery' | 'unknown';
export type ToolRunStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'timeout'
  | 'cancelled'
  | 'kill_failed';

export type ToolCleanupStatus = 'not-needed' | 'pending' | 'succeeded' | 'failed' | 'unsupported';

export interface ToolRunHandle {
  kind: 'process' | 'exec-session' | 'mcp-request' | 'plugin-job';
  id: string;
  pid?: number;
}

export interface ToolRunRecord {
  toolRunId: string;
  owner: ToolRunOwner;
  visible: boolean;
  sessionKey: string;
  runId: string | null;
  toolCallId: string;
  toolName: string;
  status: ToolRunStatus;
  startedAt: number;
  lastProgressAt: number | null;
  timeoutAt: number;
  idleTimeoutAt: number | null;
  ttlExpiresAt: number | null;
  handle?: ToolRunHandle;
  cleanup: {
    attempted: boolean;
    status: ToolCleanupStatus;
    attemptedAt: number | null;
    completedAt: number | null;
    error: string | null;
  };
  terminalReason?: string;
  message?: string;
}

export interface ToolRunTerminalEvent {
  record: ToolRunRecord;
  reason: 'hard-timeout' | 'idle-timeout' | 'ttl-expired' | 'quota-exceeded' | 'user-cancelled' | 'completed' | 'failed';
}

export interface RegisterRunningToolArgs {
  owner?: ToolRunOwner;
  visible?: boolean;
  sessionKey: string;
  runId: string | null;
  toolCallId: string;
  toolName: string;
  startedAt?: number;
  lastProgressAt?: number | null;
  handle?: ToolRunHandle;
  message?: string;
}

export interface ToolRunRegistryOptions {
  hardTimeoutMs?: number;
  idleTimeoutMs?: number;
  ttlMs?: number;
  maxActivePerSession?: number;
  maxActiveGlobal?: number;
  cleanupToolRun?: (record: ToolRunRecord, reason: string) => Promise<{ ok: boolean; unsupported?: boolean; error?: string }>;
  onTerminal?: (event: ToolRunTerminalEvent) => void;
}

const DEFAULT_HARD_TIMEOUT_MS = 120_000;
const DEFAULT_IDLE_TIMEOUT_MS = 90_000;
const DEFAULT_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_ACTIVE_PER_SESSION = 8;
const DEFAULT_MAX_ACTIVE_GLOBAL = 32;
const TOOL_QUOTA_EXCEEDED_MESSAGE = '后台工具数量已达到上限，系统已拒绝启动新的后台任务。请等待现有工具完成，或停止后重试。';

function configuredNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw ? Number(raw) : NaN;
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function cloneRecord(record: ToolRunRecord): ToolRunRecord {
  return {
    ...record,
    handle: record.handle ? { ...record.handle } : undefined,
    cleanup: { ...record.cleanup },
  };
}

function isTerminalStatus(status: ToolRunStatus): boolean {
  return status !== 'pending' && status !== 'running';
}

export class ToolRunRegistry {
  private readonly records = new Map<string, ToolRunRecord>();
  private readonly timers = new Map<string, NodeJS.Timeout[]>();
  private readonly hardTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly ttlMs: number;
  private readonly maxActivePerSession: number;
  private readonly maxActiveGlobal: number;
  private readonly cleanupToolRun?: ToolRunRegistryOptions['cleanupToolRun'];
  private readonly onTerminal?: ToolRunRegistryOptions['onTerminal'];

  constructor(options: ToolRunRegistryOptions = {}) {
    this.hardTimeoutMs = options.hardTimeoutMs ?? configuredNumber('LYCLAW_TOOL_HARD_TIMEOUT_MS', DEFAULT_HARD_TIMEOUT_MS);
    this.idleTimeoutMs = options.idleTimeoutMs ?? configuredNumber('LYCLAW_TOOL_IDLE_TIMEOUT_MS', DEFAULT_IDLE_TIMEOUT_MS);
    this.ttlMs = options.ttlMs ?? configuredNumber('LYCLAW_TOOL_TTL_MS', DEFAULT_TTL_MS);
    this.maxActivePerSession = options.maxActivePerSession ?? configuredNumber('LYCLAW_TOOL_MAX_ACTIVE_PER_SESSION', DEFAULT_MAX_ACTIVE_PER_SESSION);
    this.maxActiveGlobal = options.maxActiveGlobal ?? configuredNumber('LYCLAW_TOOL_MAX_ACTIVE_GLOBAL', DEFAULT_MAX_ACTIVE_GLOBAL);
    this.cleanupToolRun = options.cleanupToolRun;
    this.onTerminal = options.onTerminal;
  }

  registerRunningTool(args: RegisterRunningToolArgs): ToolRunRecord {
    const now = Date.now();
    const toolRunId = this.buildToolRunId(args);
    const existing = this.records.get(toolRunId);
    if (existing && existing.status === 'running') {
      existing.lastProgressAt = args.lastProgressAt ?? now;
      existing.idleTimeoutAt = existing.lastProgressAt + this.idleTimeoutMs;
      existing.message = args.message ?? existing.message;
      this.reschedule(existing);
      return cloneRecord(existing);
    }

    const startedAt = args.startedAt ?? now;
    const lastProgressAt = args.lastProgressAt ?? now;
    const record: ToolRunRecord = {
      toolRunId,
      owner: args.owner ?? 'user-run',
      visible: args.visible ?? true,
      sessionKey: args.sessionKey,
      runId: args.runId,
      toolCallId: args.toolCallId,
      toolName: args.toolName,
      status: 'running',
      startedAt,
      lastProgressAt,
      timeoutAt: startedAt + this.hardTimeoutMs,
      idleTimeoutAt: lastProgressAt + this.idleTimeoutMs,
      ttlExpiresAt: startedAt + this.ttlMs,
      handle: args.handle,
      cleanup: {
        attempted: false,
        status: args.handle ? 'pending' : 'not-needed',
        attemptedAt: null,
        completedAt: null,
        error: null,
      },
      message: args.message,
    };
    this.records.set(toolRunId, record);
    this.reschedule(record);
    void this.enforceActiveQuotas(toolRunId);
    logger.info('[tool-run-registry] registered running tool', {
      toolRunId,
      owner: record.owner,
      sessionKey: record.sessionKey,
      runId: record.runId,
      toolCallId: record.toolCallId,
      toolName: record.toolName,
      handle: record.handle,
      timeoutAt: record.timeoutAt,
      idleTimeoutAt: record.idleTimeoutAt,
      ttlExpiresAt: record.ttlExpiresAt,
    });
    return cloneRecord(record);
  }

  markTerminal(toolRunId: string, status: ToolRunStatus, reason: string): ToolRunRecord | null {
    const record = this.records.get(toolRunId);
    if (!record) return null;
    this.clearTimers(toolRunId);
    record.status = status;
    record.terminalReason = reason;
    if (!record.handle && (status === 'completed' || status === 'failed' || status === 'cancelled')) {
      record.cleanup.status = 'not-needed';
      record.cleanup.completedAt = Date.now();
    }
    return cloneRecord(record);
  }

  markProgress(toolRunId: string, progress?: { message?: string; at?: number }): ToolRunRecord | null {
    const record = this.records.get(toolRunId);
    if (!record || record.status !== 'running') return null;
    const at = progress?.at ?? Date.now();
    record.lastProgressAt = at;
    record.idleTimeoutAt = at + this.idleTimeoutMs;
    record.message = progress?.message ?? record.message;
    this.reschedule(record);
    return cloneRecord(record);
  }

  findByRun(runId: string | null | undefined): ToolRunRecord[] {
    if (!runId) return [];
    return this.list().filter((record) => record.runId === runId);
  }

  findBySession(sessionKey: string | null | undefined): ToolRunRecord[] {
    if (!sessionKey) return [];
    return this.list().filter((record) => record.sessionKey === sessionKey);
  }

  findByHandle(handle: ToolRunHandle | { kind?: string; id?: string; pid?: number } | null | undefined): ToolRunRecord[] {
    if (!handle) return [];
    const id = typeof handle.id === 'string' ? handle.id : '';
    const pid = typeof handle.pid === 'number' ? handle.pid : undefined;
    const kind = typeof handle.kind === 'string' ? handle.kind : '';
    return this.list().filter((record) => {
      if (!record.handle) return false;
      if (id && record.handle.id === id) return !kind || record.handle.kind === kind;
      if (pid && record.handle.pid === pid) return !kind || record.handle.kind === kind;
      return false;
    });
  }

  list(): ToolRunRecord[] {
    return [...this.records.values()].map(cloneRecord);
  }

  listActive(sessionKey?: string): ToolRunRecord[] {
    return this.list().filter((record) =>
      record.status === 'running' && (!sessionKey || record.sessionKey === sessionKey));
  }

  async cancelToolRun(toolRunId: string, reason: string): Promise<ToolRunRecord | null> {
    const record = this.records.get(toolRunId);
    if (!record || isTerminalStatus(record.status)) return record ? cloneRecord(record) : null;
    this.clearTimers(toolRunId);
    record.status = 'cancelled';
    record.terminalReason = reason;
    await this.cleanupTerminalRecord(record, reason);
    this.onTerminal?.({ record: cloneRecord(record), reason: 'user-cancelled' });
    return cloneRecord(record);
  }

  async cancelByRun(runId: string | null | undefined, reason: string): Promise<ToolRunRecord[]> {
    const records = this.findByRun(runId).filter((record) => record.status === 'running');
    const results: ToolRunRecord[] = [];
    for (const record of records) {
      const cancelled = await this.cancelToolRun(record.toolRunId, reason);
      if (cancelled) results.push(cancelled);
    }
    return results;
  }

  async cancelBySession(sessionKey: string | null | undefined, reason: string): Promise<ToolRunRecord[]> {
    const records = this.findBySession(sessionKey).filter((record) => record.status === 'running');
    const results: ToolRunRecord[] = [];
    for (const record of records) {
      const cancelled = await this.cancelToolRun(record.toolRunId, reason);
      if (cancelled) results.push(cancelled);
    }
    return results;
  }

  async cleanupCompletedToolRun(toolRunId: string, reason = 'completed'): Promise<ToolRunRecord | null> {
    const record = this.records.get(toolRunId);
    if (!record) return null;
    this.clearTimers(toolRunId);
    if (record.status === 'running' || record.status === 'pending') {
      record.status = 'completed';
      record.terminalReason = reason;
    }
    await this.cleanupTerminalRecord(record, reason);
    return cloneRecord(record);
  }

  getQuotaSnapshot(): {
    maxActivePerSession: number;
    maxActiveGlobal: number;
    activeGlobal: number;
    activeBySession: Record<string, number>;
  } {
    const active = this.listActive();
    const activeBySession: Record<string, number> = {};
    for (const record of active) {
      activeBySession[record.sessionKey] = (activeBySession[record.sessionKey] ?? 0) + 1;
    }
    return {
      maxActivePerSession: this.maxActivePerSession,
      maxActiveGlobal: this.maxActiveGlobal,
      activeGlobal: active.length,
      activeBySession,
    };
  }

  private async enforceActiveQuotas(toolRunId: string): Promise<void> {
    const record = this.records.get(toolRunId);
    if (!record || record.status !== 'running') return;
    const active = [...this.records.values()].filter((item) => item.status === 'running');
    const activeForSession = active.filter((item) => item.sessionKey === record.sessionKey);
    const sessionExceeded = activeForSession.length > this.maxActivePerSession;
    const globalExceeded = active.length > this.maxActiveGlobal;
    if (!sessionExceeded && !globalExceeded) return;
    await this.failRunningToolRun(
      toolRunId,
      'quota-exceeded',
      TOOL_QUOTA_EXCEEDED_MESSAGE,
    );
  }

  private async failRunningToolRun(
    toolRunId: string,
    reason: 'quota-exceeded',
    message: string,
  ): Promise<void> {
    const record = this.records.get(toolRunId);
    if (!record || record.status !== 'running') return;
    this.clearTimers(toolRunId);
    record.status = 'failed';
    record.terminalReason = reason;
    record.message = message;
    logger.warn('[tool-run-registry] tool failed by lifecycle policy; cleanup starting', {
      toolRunId,
      reason,
      message,
      sessionKey: record.sessionKey,
      runId: record.runId,
      toolCallId: record.toolCallId,
      toolName: record.toolName,
      handle: record.handle,
    });
    await this.cleanupTerminalRecord(record, reason);
    this.onTerminal?.({ record: cloneRecord(record), reason });
  }
  clear(): void {
    for (const toolRunId of this.records.keys()) {
      this.clearTimers(toolRunId);
    }
    this.records.clear();
  }

  private buildToolRunId(args: RegisterRunningToolArgs): string {
    const handleKey = args.handle ? `${args.handle.kind}:${args.handle.id}:${args.handle.pid ?? ''}` : 'no-handle';
    return `${args.sessionKey}::${args.runId ?? 'no-run'}::${args.toolCallId || handleKey}`;
  }

  private reschedule(record: ToolRunRecord): void {
    this.clearTimers(record.toolRunId);
    const now = Date.now();
    const timers: NodeJS.Timeout[] = [];
    timers.push(setTimeout(() => {
      void this.timeoutToolRun(record.toolRunId, 'hard-timeout');
    }, Math.max(0, record.timeoutAt - now)));
    if (record.idleTimeoutAt) {
      timers.push(setTimeout(() => {
        void this.timeoutToolRun(record.toolRunId, 'idle-timeout');
      }, Math.max(0, record.idleTimeoutAt - now)));
    }
    if (record.ttlExpiresAt) {
      timers.push(setTimeout(() => {
        void this.timeoutToolRun(record.toolRunId, 'ttl-expired');
      }, Math.max(0, record.ttlExpiresAt - now)));
    }
    this.timers.set(record.toolRunId, timers);
  }

  private clearTimers(toolRunId: string): void {
    const timers = this.timers.get(toolRunId);
    if (!timers) return;
    for (const timer of timers) clearTimeout(timer);
    this.timers.delete(toolRunId);
  }

  private async cleanupTerminalRecord(record: ToolRunRecord, reason: string): Promise<void> {
    if (record.cleanup.attempted || record.cleanup.status === 'succeeded') return;
    if (!record.handle) {
      record.cleanup.status = 'not-needed';
      record.cleanup.completedAt = Date.now();
      return;
    }
    record.cleanup.attempted = true;
    record.cleanup.status = 'pending';
    record.cleanup.attemptedAt = Date.now();

    if (!this.cleanupToolRun) {
      record.cleanup.status = 'unsupported';
      record.cleanup.completedAt = Date.now();
      record.cleanup.error = 'cleanup callback is not configured';
      return;
    }

    try {
      const result = await this.cleanupToolRun(cloneRecord(record), reason);
      record.cleanup.completedAt = Date.now();
      if (result.ok) {
        record.cleanup.status = 'succeeded';
      } else if (result.unsupported) {
        record.cleanup.status = 'unsupported';
        record.cleanup.error = result.error ?? 'cleanup unsupported';
      } else {
        record.status = 'kill_failed';
        record.terminalReason = 'kill-failed';
        record.cleanup.status = 'failed';
        record.cleanup.error = result.error ?? 'cleanup failed';
      }
    } catch (error) {
      record.status = 'kill_failed';
      record.terminalReason = 'kill-failed';
      record.cleanup.status = 'failed';
      record.cleanup.completedAt = Date.now();
      record.cleanup.error = String(error);
    }
  }

  private async timeoutToolRun(
    toolRunId: string,
    reason: 'hard-timeout' | 'idle-timeout' | 'ttl-expired',
  ): Promise<void> {
    const record = this.records.get(toolRunId);
    if (!record || record.status !== 'running') return;
    this.clearTimers(toolRunId);

    record.status = 'timeout';
    record.terminalReason = reason;
    logger.warn('[tool-run-registry] tool timed out; cleanup starting', {
      toolRunId,
      reason,
      sessionKey: record.sessionKey,
      runId: record.runId,
      toolCallId: record.toolCallId,
      toolName: record.toolName,
      handle: record.handle,
    });

    await this.cleanupTerminalRecord(record, reason);

    logger.warn('[tool-run-registry] tool terminal after timeout', {
      toolRunId,
      status: record.status,
      terminalReason: record.terminalReason,
      cleanup: record.cleanup,
      handle: record.handle,
    });
    this.onTerminal?.({ record: cloneRecord(record), reason });
  }
}