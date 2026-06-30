/**
 * Gateway Process Manager
 * Manages the OpenClaw Gateway process lifecycle
 */
import { app } from 'electron';
import { readFile, readdir, stat } from 'fs/promises';
import path from 'path';
import { homedir } from 'os';
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { PORTS } from '../utils/config';
import { JsonRpcNotification, isNotification, isResponse } from './protocol';
import { logger } from '../utils/logger';
import { protectMemoryRpcOutput } from '../security/memory-content-policy';
import { enrichChatSendParams } from '../utils/chat-send-enrichment';
import { captureTelemetryEvent, trackMetric } from '../utils/telemetry';
// Dev-only Langfuse chat tracing �?uncomment with electron/main/index.ts langfuse import.
// import {
//   beginChatSendTrace,
//   finishChatRunTrace,
//   finishChatSendRpc,
//   recordChatRunPending,
//   recordChatSendPending,
//   recordChatStreamEvent,
//   recordGatewayModelUsage,
// } from '../utils/langfuse-chat-tracing';
import {
  loadOrCreateDeviceIdentity,
  type DeviceIdentity,
} from '../utils/device-identity';
import {
  DEFAULT_RECONNECT_CONFIG,
  type ReconnectConfig,
  type GatewayLifecycleState,
  getReconnectScheduleDecision,
  getReconnectSkipReason,
} from './process-policy';
import {
  clearPendingGatewayRequests,
  rejectPendingGatewayRequest,
  resolvePendingGatewayRequest,
  type PendingGatewayRequest,
} from './request-store';
import { dispatchJsonRpcNotification, dispatchProtocolEvent } from './event-dispatch';
import { GatewayStateController } from './state';
import { prepareGatewayLaunchContext } from './config-sync';
import { connectGatewaySocket, waitForGatewayReady } from './ws-client';
import {
  findExistingGatewayProcess,
  runOpenClawDoctorRepair,
  terminateOwnedGatewayProcess,
  unloadLaunchctlGatewayService,
  waitForPortFree,
  warmupManagedPythonReadiness,
  cleanupStaleSessionLocks,
} from './supervisor';
import { GatewayConnectionMonitor } from './connection-monitor';
import { GatewayLifecycleController, LifecycleSupersededError } from './lifecycle-controller';
import { launchGatewayProcess } from './process-launcher';
import { GatewayRestartController } from './restart-controller';
import { GatewayRestartGovernor } from './restart-governor';
import {
  DEFAULT_GATEWAY_RELOAD_POLICY,
  loadGatewayReloadPolicy,
  type GatewayReloadPolicy,
} from './reload-policy';
import {
  classifyGatewayStderrMessage,
  parseGatewayStuckSessionDiagnostic,
  parseSessionWriteLockLog,
  recordGatewayStartupStderrLine,
  type GatewayStuckSessionDiagnostic,
} from './startup-stderr';
import { runGatewayStartupSequence } from './startup-orchestrator';
import { isInvalidConfigSignal } from './startup-recovery';
import { ensureClawXContext } from '../utils/openclaw-workspace';
import { inspectOpenClawDigitalEmployeeIsolation } from '../utils/openclaw-digital-employee-isolation';
import { handleGatewayExecApprovalRequested } from './exec-approval-bridge';
import {
  recoverOrphanedSessionTranscriptLock,
  recoverStaleSessionAfterEmptyFinal,
  type SessionTranscriptLockRecoveryResult,
  type StaleSessionRecoveryResult,
} from './session-lock-recovery';
import {
  ToolRunRegistry,
  type ToolRunRecord,
  type ToolRunHandle,
} from '../runtime/tool-run-registry';
import { isSessionProcessingLiveOnDisk } from './session-processing-liveness';
import { hasActiveExecInSessionTranscript } from './session-exec-liveness';


export interface GatewayStatus {
  state: GatewayLifecycleState;
  port: number;
  pid?: number;
  uptime?: number;
  error?: string;
  connectedAt?: number;
  version?: string;
  reconnectAttempts?: number;
  /** True once the gateway's internal subsystems (skills, plugins) are ready for RPC calls. */
  gatewayReady?: boolean;
  /** Warmup status: 'idle' | 'warming' | 'ready' | 'failed' */
  warmupStatus?: 'idle' | 'warming' | 'ready' | 'failed';
  /** Most recent OpenClaw stuck-session diagnostic emitted by Gateway stderr. */
  lastStuckSessionAt?: number;
  lastStuckSession?: GatewayStuckSessionDiagnostic;
}

export type GatewayHealthState = 'healthy' | 'degraded' | 'unresponsive';

export interface GatewayHealthSummary {
  state: GatewayHealthState;
  reasons: string[];
  consecutiveHeartbeatMisses: number;
  lastAliveAt?: number;
  lastRpcSuccessAt?: number;
  lastRpcFailureAt?: number;
  lastRpcFailureMethod?: string;
  lastChannelsStatusOkAt?: number;
  lastChannelsStatusFailureAt?: number;
  lastStuckSessionAt?: number;
  lastStuckSession?: GatewayStuckSessionDiagnostic;
}

export interface GatewayDiagnosticsSnapshot {
  lastAliveAt?: number;
  lastRpcSuccessAt?: number;
  lastRpcFailureAt?: number;
  lastRpcFailureMethod?: string;
  lastHeartbeatTimeoutAt?: number;
  lastStuckSessionAt?: number;
  lastStuckSession?: GatewayStuckSessionDiagnostic;
  consecutiveHeartbeatMisses: number;
  lastSocketCloseAt?: number;
  lastSocketCloseCode?: number;
  consecutiveRpcFailures: number;
  activeToolRuns?: Array<Record<string, unknown>>;
  terminalToolRuns?: Array<Record<string, unknown>>;
  activeBackgroundProcessCount?: number;
  killFailedToolRunCount?: number;
  toolRunQuota?: Record<string, unknown>;
}

type TrackedChatRunSnapshot = Array<{
  runId: string;
  kind: 'user' | 'warmup' | 'internal';
  sessionKey?: string;
  ageSinceAcceptedMs: number;
  ageSinceRequestedMs: number;
  hasFirstDelta: boolean;
  hasFirstVisibleProgress: boolean;
  firstVisibleProgressKind?: string;
}>;

type GatewayChatEvent = {
  state?: unknown;
  runId?: unknown;
  message?: unknown;
};

type ChatRunMetric = {
  kind: 'user' | 'warmup' | 'internal';
  sessionKey?: string;
  requestedAt: number;
  acceptedAt: number;
  rpcDurationMs: number;
  firstEventAt?: number;
  firstDeltaAt?: number;
  firstVisibleProgressAt?: number;
  firstVisibleProgressKind?: string;
  firstEventWatchdogTimers?: NodeJS.Timeout[];
  firstVisibleProgressWatchdogTimers?: NodeJS.Timeout[];
};

export type EmptyFinalDiagnostic = {
  runId: string;
  sessionKey?: string;
  recordedAt: number;
  totalSinceAcceptedMs: number;
  totalSinceRequestedMs: number;
  timeToFirstEventMs: number | null;
  timeToFirstDeltaMs: number | null;
  timeToFirstVisibleProgressMs: number | null;
  firstVisibleProgressKind?: string;
  rpcDurationMs: number;
  trackedChatRunsBeforeCompletion: TrackedChatRunSnapshot;
  gatewayPid: number;
  recoveryResult?: SessionTranscriptLockRecoveryResult;
  sessionStoreEntry?: unknown;
  sessionFiles?: unknown;
  transcriptFile?: unknown;
  transcriptLock?: unknown;
  transcriptLockOwner?: unknown;
  sessionStoreReadError?: string;
};

function isTransportRpcFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('RPC timeout:')
    || message.includes('Gateway not connected')
    || message.includes('Gateway stopped')
    || message.includes('Failed to send RPC request:');
}

/**
 * Gateway Manager Events
 */
export interface GatewayManagerEvents {
  status: (status: GatewayStatus) => void;
  message: (message: unknown) => void;
  notification: (notification: JsonRpcNotification) => void;
  exit: (code: number | null) => void;
  error: (error: Error) => void;
  'channel:status': (data: { channelId: string; status: string }) => void;
  'chat:message': (data: { message: unknown }) => void;
}

/**
 * Gateway Manager
 * Handles starting, stopping, and communicating with the OpenClaw Gateway
 */
export class GatewayManager extends EventEmitter {
  private process: Electron.UtilityProcess | null = null;
  private processExitCode: number | null = null; // set by exit event, replaces exitCode/signalCode
  private ownsProcess = false;
  private ws: WebSocket | null = null;
  private status: GatewayStatus = { state: 'stopped', port: PORTS.OPENCLAW_GATEWAY, warmupStatus: 'idle' };
  private readonly stateController: GatewayStateController;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private reconnectConfig: ReconnectConfig;
  private shouldReconnect = true;
  private startLock = false;
  private lastSpawnSummary: string | null = null;
  private recentStartupStderrLines: string[] = [];
  private lastGatewayDebugSessionId: string | undefined;
  private lastGatewayDebugProvider: string | undefined;
  private pendingRequests: Map<string, PendingGatewayRequest> = new Map();
  private deviceIdentity: DeviceIdentity | null = null;
  private restartInFlight: Promise<void> | null = null;
  private readonly connectionMonitor = new GatewayConnectionMonitor();
  private readonly lifecycleController = new GatewayLifecycleController();
  private readonly restartController = new GatewayRestartController();
  private readonly restartGovernor = new GatewayRestartGovernor();
  private reloadDebounceTimer: NodeJS.Timeout | null = null;
  private reloadPolicy: GatewayReloadPolicy = { ...DEFAULT_GATEWAY_RELOAD_POLICY };
  private reloadPolicyLoadedAt = 0;
  private reloadPolicyRefreshPromise: Promise<void> | null = null;
  private externalShutdownSupported: boolean | null = null;
  private reconnectAttemptsTotal = 0;
  private reconnectSuccessTotal = 0;
  private static readonly RELOAD_POLICY_REFRESH_MS = 15_000;
  private static readonly HEARTBEAT_INTERVAL_MS = 30_000;
  private static readonly HEARTBEAT_TIMEOUT_MS = 12_000;
  private static readonly HEARTBEAT_MAX_MISSES = 3;
  // Windows-specific heartbeat parameters �?more lenient to reduce log noise
  // from false positives caused by Windows Defender scans, system updates,
  // and synchronous event-loop blocking in the gateway.
  private static readonly HEARTBEAT_INTERVAL_MS_WIN = 60_000;
  private static readonly HEARTBEAT_TIMEOUT_MS_WIN = 25_000;
  private static readonly HEARTBEAT_MAX_MISSES_WIN = 5;
  public static readonly RESTART_COOLDOWN_MS = 5_000;
  private static readonly GATEWAY_READY_FALLBACK_MS = 2_000;
  private static readonly GATEWAY_READY_PROBE_TIMEOUT_MS = 1_500;
  private static readonly TERMINAL_LOCK_AUDIT_DELAY_MS = 5_000;
  private lastRestartAt = 0;
  /** Set by scheduleReconnect() before calling start() to signal auto-reconnect. */
  private isAutoReconnectStart = false;
  private gatewayReadyFallbackTimer: NodeJS.Timeout | null = null;
  private skipWarmupAfterRestart = false;
  private isWarmedUp = false;
  private hasWarmupFailed = false;
  private warmupTimer: NodeJS.Timeout | null = null;
  private warmupRequestPromise: Promise<void> | null = null;
  private warmupStartedAt: number | null = null;
  private rpcInflight = new Map<string, {
    method: string;
    startedAt: number;
    timeoutMs: number;
    sessionKey?: string;
  }>();
  private chatRunMetrics = new Map<string, ChatRunMetric>();
  private readonly emptyFinalDiagnosticsBySession = new Map<string, EmptyFinalDiagnostic>();
  private readonly terminalLockAuditTimersBySession = new Map<string, NodeJS.Timeout>();
  private warmupRunWaiters = new Map<string, {
    resolve: (state: string) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
    startedAt: number;
  }>();
  private warmupBackgroundReleaseChain: Promise<void> = Promise.resolve();
  private readonly chatSendWatchdogDelaysMs = [10_000, 30_000, 60_000, 90_000];
  private readonly chatRunFirstEventWatchdogDelaysMs = [10_000, 30_000, 60_000];
  private readonly chatRunFirstVisibleProgressWatchdogDelaysMs = [5_000, 10_000, 30_000, 60_000];
  private diagnostics: GatewayDiagnosticsSnapshot = {
    consecutiveHeartbeatMisses: 0,
    consecutiveRpcFailures: 0,
  };
  private readonly toolFailureFeedbackCounts = new Map<string, number>();
  private readonly toolRunRegistry = new ToolRunRegistry({
    cleanupToolRun: async (record, reason) => this.cleanupToolRun(record, reason),
    onTerminal: (event) => this.emitToolRunTerminalEvent(event.record),
  });
  private static readonly WARMUP_DELAY_MS = 250;
  private static readonly WARMUP_FIRST_OUTPUT_TIMEOUT_MS = 120_000;
  private static readonly WARMUP_BACKGROUND_RPC_RELEASE_MS = 10_000;
  private static readonly WARMUP_NEAR_COMPLETION_WAIT_MS = 3_000;
  private static readonly WARMUP_NEAR_COMPLETION_AFTER_MS = 40_000;
  private static readonly WARMUP_CLEANUP_DELAY_MS = 5_000;
  private static readonly CHAT_WARMUP_ENABLED = process.env.LYCLAW_ENABLE_CHAT_WARMUP === '1';

  constructor(config?: Partial<ReconnectConfig>) {
    super();
    this.stateController = new GatewayStateController({
      emitStatus: (status) => {
        this.status = status;
        this.emit('status', status);
      },
      onTransition: (previousState, nextState) => {
        if (nextState === 'running') {
          this.restartGovernor.onRunning();
        }
        this.restartController.flushDeferredRestart(
          `status:${previousState}->${nextState}`,
          {
            state: this.status.state,
            startLock: this.startLock,
            shouldReconnect: this.shouldReconnect,
          },
          () => {
            void this.restart().catch((error) => {
              logger.warn('Deferred Gateway restart failed:', error);
            });
          },
        );
      },
    });
    this.reconnectConfig = { ...DEFAULT_RECONNECT_CONFIG, ...config };
    // Device identity is loaded lazily in start() �?not in the constructor �?
    // so that async file I/O and key generation don't block module loading.

    this.on('gateway:ready', () => {
      this.clearGatewayReadyFallback();
      if (this.status.state === 'running' && !this.status.gatewayReady) {
        logger.info('Gateway subsystems ready (event received)');
        this.setStatus({ gatewayReady: true });
        this.warmupGateway();
      }
    });
  }

  private async initDeviceIdentity(): Promise<void> {
    if (this.deviceIdentity) return; // already loaded
    try {
      const identityPath = path.join(app.getPath('userData'), 'LYClaw-device-identity.json');
      this.deviceIdentity = await loadOrCreateDeviceIdentity(identityPath);
      logger.debug(`Device identity loaded (deviceId=${this.deviceIdentity.deviceId})`);
    } catch (err) {
      logger.warn('Failed to load device identity, scopes will be limited:', err);
    }
  }

  private sanitizeSpawnArgs(args: string[]): string[] {
    const sanitized = [...args];
    const tokenIdx = sanitized.indexOf('--token');
    if (tokenIdx !== -1 && tokenIdx + 1 < sanitized.length) {
      sanitized[tokenIdx + 1] = '[redacted]';
    }
    return sanitized;
  }

  private isUnsupportedShutdownError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /unknown method:\s*shutdown/i.test(message);
  }
  /**
   * Get current Gateway status
   */
  getStatus(): GatewayStatus {
    return this.stateController.getStatus();
  }

  getDiagnostics(): GatewayDiagnosticsSnapshot {
    const toolRuns = this.toolRunRegistry.list();
    const activeToolRuns = toolRuns.filter((record) => record.status === 'running');
    return {
      ...this.diagnostics,
      activeToolRuns,
      terminalToolRuns: toolRuns.filter((record) => record.status !== 'running').slice(-20),
      activeBackgroundProcessCount: activeToolRuns.filter((record) => record.handle?.kind === 'process').length,
      killFailedToolRunCount: toolRuns.filter((record) => record.status === 'kill_failed').length,
      toolRunQuota: this.toolRunRegistry.getQuotaSnapshot(),
    };
  }

  /**
   * Check if Gateway is connected and ready
   */
  isConnected(): boolean {
    return this.stateController.isConnected(this.ws?.readyState === WebSocket.OPEN);
  }

  /**
   * Start Gateway process
   */
  async start(): Promise<void> {
    if (this.startLock) {
      logger.debug('Gateway start ignored because a start flow is already in progress');
      return;
    }

    if (this.status.state === 'running') {
      logger.debug('Gateway already running, skipping start');
      return;
    }

    this.startLock = true;
    const startEpoch = this.lifecycleController.bump('start');
    logger.info(`Gateway start requested (port=${this.status.port})`);
    this.lastSpawnSummary = null;
    this.shouldReconnect = true;
    await this.refreshReloadPolicy(true);

    // Lazily load device identity (async file I/O + key generation).
    // Must happen before connect() which uses the identity for the handshake.
    await this.initDeviceIdentity();

    // Manual start should override and cancel any pending reconnect timer.
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      logger.debug('Cleared pending reconnect timer because start was requested manually');
    }

    // Only reset reconnectAttempts on manual start, not on auto-reconnect.
    // Auto-reconnect calls start() via scheduleReconnect(); those should
    // accumulate attempts so the maxAttempts cap works correctly.
    if (!this.isAutoReconnectStart) {
      this.reconnectAttempts = 0;
    }
    this.isAutoReconnectStart = false; // consume the flag
    this.setStatus({ state: 'starting', reconnectAttempts: this.reconnectAttempts, gatewayReady: false });

    // Check if Python environment is ready (self-healing) asynchronously.
    // Fire-and-forget: only needs to run once, not on every retry.
    warmupManagedPythonReadiness();

    const t0 = Date.now();
    let tSpawned = 0;
    let tReady = 0;

    try {
      await runGatewayStartupSequence({
        port: this.status.port,
        ownedPid: this.process?.pid,
        shouldWaitForPortFree: process.platform === 'win32',
        hasOwnedProcess: () => this.process?.pid != null && this.ownsProcess,
        resetStartupStderrLines: () => {
          this.recentStartupStderrLines = [];
        },
        getStartupStderrLines: () => this.recentStartupStderrLines,
        assertLifecycle: (phase) => {
          this.lifecycleController.assert(startEpoch, phase);
        },
        findExistingGateway: async (port) => {
          // Always read the current process pid dynamically so that retries
          // don't treat a just-spawned gateway as an orphan.  The ownedPid
          // snapshot captured at start() entry is stale after startProcess()
          // replaces this.process �?leading to the just-started pid being
          // immediately killed as a false orphan on the next retry iteration.
          return await findExistingGatewayProcess({ port, ownedPid: this.process?.pid });
        },
        connect: async (port, externalToken) => {
          await this.connect(port, externalToken);
        },
        onConnectedToExistingGateway: () => {
          // If the existing gateway is actually our own spawned UtilityProcess
          // (e.g. after a self-restart code=1012), keep ownership so that
          // stop() can still terminate the process during a restart() cycle.
          const isOwnProcess = this.process?.pid != null && this.ownsProcess;
          if (!isOwnProcess) {
            this.ownsProcess = false;
            this.setStatus({ pid: undefined });
          }

          // Treat a successful reconnect to the owned process as a restart
          // completion (e.g. after a Gateway code-1012 in-process restart).
          // This updates lastRestartCompletedAt so that flushDeferredRestart
          // drops any deferred restart requested before this reconnect,
          // avoiding a redundant kill+respawn cycle.
          if (isOwnProcess) {
            this.restartController.recordRestartCompleted();
          }

          this.startHealthCheck();
        },
        waitForPortFree: async (port) => {
          await waitForPortFree(port);
        },
        startProcess: async () => {
          await this.startProcess();
          tSpawned = Date.now();
        },
        waitForReady: async (port) => {
          await waitForGatewayReady({
            port,
            getProcessExitCode: () => this.processExitCode,
          });
          tReady = Date.now();
        },
        onConnectedToManagedGateway: () => {
          this.startHealthCheck();
          const tConnected = Date.now();
          logger.info('[metric] gateway.startup', {
            configSyncMs: tSpawned ? tSpawned - t0 : undefined,
            spawnToReadyMs: tReady && tSpawned ? tReady - tSpawned : undefined,
            readyToConnectMs: tReady ? tConnected - tReady : undefined,
            totalMs: tConnected - t0,
          });
          
        },
        runDoctorRepair: async () => await runOpenClawDoctorRepair(),
        onDoctorRepairSuccess: () => {
          this.setStatus({ state: 'starting', error: undefined, reconnectAttempts: 0 });
        },
        delay: async (ms) => {
          await new Promise((resolve) => setTimeout(resolve, ms));
        },
        cleanupStaleLocks: async () => await cleanupStaleSessionLocks(),
      });
    } catch (error) {
      if (error instanceof LifecycleSupersededError) {
        logger.debug(error.message);
        return;
      }
      logger.error(
        `Gateway start failed (port=${this.status.port}, reconnectAttempts=${this.reconnectAttempts}, spawn=${this.lastSpawnSummary ?? 'n/a'})`,
        error
      );
      this.setStatus({ state: 'error', error: String(error) });
      throw error;
    } finally {
      this.startLock = false;
      this.restartController.flushDeferredRestart(
        'start:finally',
        {
          state: this.status.state,
          startLock: this.startLock,
          shouldReconnect: this.shouldReconnect,
        },
        () => {
          void this.restart().catch((error) => {
            logger.warn('Deferred Gateway restart failed:', error);
          });
        },
      );
    }
  }

  /**
   * Stop Gateway process
   */
  async stop(): Promise<void> {
    logger.info('Gateway stop requested');
    this.lifecycleController.bump('stop');
    // Disable auto-reconnect
    this.shouldReconnect = false;

    await this.settleTrackedUserRunsForGatewayStop('gateway-stopped');

    // Clear all timers
    this.clearAllTimers();

    // If this manager is attached to an external gateway process, ask it to shut down
    // over protocol before closing the socket.
    if (!this.ownsProcess && this.ws?.readyState === WebSocket.OPEN && this.externalShutdownSupported !== false) {
      try {
        await this.rpc('shutdown', undefined, 5000);
        this.externalShutdownSupported = true;
      } catch (error) {
        if (this.isUnsupportedShutdownError(error)) {
          this.externalShutdownSupported = false;
          logger.info('External Gateway does not support "shutdown"; skipping shutdown RPC for future stops');
        } else {
          logger.warn('Failed to request shutdown for externally managed Gateway:', error);
        }
      }
    }

    // Close WebSocket �?use terminate() to force-close the TCP connection
    // immediately without waiting for the WebSocket close handshake.
    // ws.close() sends a close frame and waits for the server to respond;
    // if the gateway process is being killed concurrently, the handshake
    // never completes and the connection stays ESTABLISHED indefinitely,
    // accumulating leaked connections on every restart cycle.
    if (this.ws) {
      try { this.ws.terminate(); } catch { /* ignore */ }
      this.ws = null;
    }

    // Kill process
    if (this.process && this.ownsProcess) {
      const child = this.process;
      await terminateOwnedGatewayProcess(child);

      if (this.process === child) {
        this.process = null;
      }
    }
    this.ownsProcess = false;

    clearPendingGatewayRequests(this.pendingRequests, new Error('Gateway stopped'));

    this.restartController.resetDeferredRestart();
    this.isAutoReconnectStart = false;
    this.isWarmedUp = false;
    this.diagnostics.consecutiveHeartbeatMisses = 0;
    this.setStatus({ state: 'stopped', error: undefined, pid: undefined, connectedAt: undefined, uptime: undefined, gatewayReady: undefined, warmupStatus: 'idle' });
  }

  /**
   * Best-effort emergency cleanup for app-quit timeout paths.
   * Only terminates a process this manager still owns.
   */
  async forceTerminateOwnedProcessForQuit(): Promise<boolean> {
    if (!this.process || !this.ownsProcess) {
      return false;
    }

    const child = this.process;
    await terminateOwnedGatewayProcess(child);
    if (this.process === child) {
      this.process = null;
    }
    this.ownsProcess = false;
    this.setStatus({ pid: undefined });
    return true;
  }

  /**
   * Restart Gateway process
   */
  async restart(): Promise<void> {
    if (this.restartController.isRestartDeferred({
      state: this.status.state,
      startLock: this.startLock,
    })) {
      this.restartController.markDeferredRestart('restart', {
        state: this.status.state,
        startLock: this.startLock,
      });
      return;
    }

    if (this.restartInFlight) {
      logger.debug('Gateway restart already in progress, joining existing request');
      await this.restartInFlight;
      return;
    }

    const decision = this.restartGovernor.decide();
    if (!decision.allow) {
      const observability = this.restartGovernor.getObservability();
      logger.warn(
        `[gateway-restart-governor] restart suppressed reason=${decision.reason} retryAfterMs=${decision.retryAfterMs} ` +
        `suppressed=${observability.suppressed_total} executed=${observability.executed_total} circuitOpenUntil=${observability.circuit_open_until}`,
      );
      const props = {
        reason: decision.reason,
        retry_after_ms: decision.retryAfterMs,
        gateway_restart_suppressed_total: observability.suppressed_total,
        gateway_restart_executed_total: observability.executed_total,
        gateway_restart_circuit_open_until: observability.circuit_open_until,
      };
      trackMetric('gateway.restart.suppressed', props);
      captureTelemetryEvent('gateway_restart_suppressed', props);
      return;
    }

    const pidBefore = this.status.pid;
    logger.info(`[gateway-refresh] mode=restart requested pidBefore=${pidBefore ?? 'n/a'}`);
    this.restartInFlight = (async () => {
      await this.stop();
      this.skipWarmupAfterRestart = true;
      try {
        await this.start();
      } catch (err) {
        this.skipWarmupAfterRestart = false;
        // stop() set shouldReconnect=false. Restore it so the gateway
        // can self-heal via scheduleReconnect() instead of dying permanently.
        logger.warn('Gateway restart: start() failed after stop(), enabling auto-reconnect recovery', err);
        this.shouldReconnect = true;
        this.scheduleReconnect();
        throw err;
      }
    })();

    try {
      await this.restartInFlight;
      this.restartGovernor.recordExecuted();
      this.restartController.recordRestartCompleted();
      const observability = this.restartGovernor.getObservability();
      const props = {
        gateway_restart_executed_total: observability.executed_total,
        gateway_restart_suppressed_total: observability.suppressed_total,
        gateway_restart_circuit_open_until: observability.circuit_open_until,
      };
      trackMetric('gateway.restart.executed', props);
      captureTelemetryEvent('gateway_restart_executed', props);
      logger.info(
        `[gateway-refresh] mode=restart result=applied pidBefore=${pidBefore ?? 'n/a'} pidAfter=${this.status.pid ?? 'n/a'} ` +
        `suppressed=${observability.suppressed_total} executed=${observability.executed_total} circuitOpenUntil=${observability.circuit_open_until}`,
      );
    } finally {
      this.restartInFlight = null;
      this.restartController.flushDeferredRestart(
        'restart:finally',
        {
          state: this.status.state,
          startLock: this.startLock,
          shouldReconnect: this.shouldReconnect,
        },
        () => {
          void this.restart().catch((error) => {
            logger.warn('Deferred Gateway restart failed:', error);
          });
        },
      );
    }
  }

  /**
   * Debounced restart �?coalesces multiple rapid restart requests into a
   * single restart after `delayMs` of inactivity.  This prevents the
   * cascading stop/start cycles that occur when provider:save,
   * provider:setDefault and channel:saveConfig all fire within seconds
   * of each other during setup.
   */
  debouncedRestart(delayMs = 2000): void {
    this.restartController.debouncedRestart(delayMs, () => {
      void this.restart().catch((err) => {
        logger.warn('Debounced Gateway restart failed:', err);
      });
    });
  }

  /**
   * Ask the Gateway process to reload config in-place when possible.
   * Falls back to restart on unsupported platforms or signaling failures.
   */
  async reload(): Promise<void> {
    await this.refreshReloadPolicy();

    if (this.reloadPolicy.mode === 'off' || this.reloadPolicy.mode === 'restart') {
      logger.info(
        `[gateway-refresh] mode=reload result=policy_forced_restart policy=${this.reloadPolicy.mode}`,
      );
      await this.restart();
      return;
    }

    if (this.restartController.isRestartDeferred({
      state: this.status.state,
      startLock: this.startLock,
    })) {
      this.restartController.markDeferredRestart('reload', {
        state: this.status.state,
        startLock: this.startLock,
      });
      return;
    }

    const pidBefore = this.process?.pid;
    logger.info(`[gateway-refresh] mode=reload requested pid=${pidBefore ?? 'n/a'} state=${this.status.state}`);

    if (!this.process?.pid || this.status.state !== 'running') {
      logger.warn('[gateway-refresh] mode=reload result=fallback_restart cause=not_running');
      logger.warn('Gateway reload requested while not running; falling back to restart');
      await this.restart();
      return;
    }

    const connectedForMs = this.status.connectedAt
      ? Date.now() - this.status.connectedAt
      : Number.POSITIVE_INFINITY;

    // Avoid signaling a process that just came up; it will already read latest config.
    if (connectedForMs < 8000) {
      logger.info(
        `[gateway-refresh] mode=reload result=skipped_recent_connect connectedForMs=${connectedForMs} pid=${this.process.pid}`,
      );
      logger.info(`Gateway connected ${connectedForMs}ms ago, skipping reload signal`);
      return;
    }

    if (process.platform === 'win32') {
      // Windows does not support SIGUSR1 for in-process reload.
      // Fall back to a full restart.  The connectedForMs < 8000 guard above
      // already skips unnecessary restarts for recently-started processes.
      logger.warn('[gateway-refresh] mode=reload result=fallback_restart cause=windows');
      await this.restart();
      return;
    }

    try {
      process.kill(this.process.pid, 'SIGUSR1');
      logger.info(`Sent SIGUSR1 to Gateway for config reload (pid=${this.process.pid})`);
      // Some gateway builds do not handle SIGUSR1 as an in-process reload.
      // If process state doesn't recover quickly, fall back to restart.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      if (this.status.state !== 'running' || !this.process?.pid) {
        logger.warn('[gateway-refresh] mode=reload result=fallback_restart cause=post_signal_unhealthy');
        logger.warn('Gateway did not stay running after reload signal, falling back to restart');
        await this.restart();
      } else {
        const pidAfter = this.process.pid;
        logger.info(
          `[gateway-refresh] mode=reload result=applied_in_place pidBefore=${pidBefore} pidAfter=${pidAfter}`,
        );
      }
    } catch (error) {
      logger.warn('[gateway-refresh] mode=reload result=fallback_restart cause=signal_error');
      logger.warn('Gateway reload signal failed, falling back to restart:', error);
      await this.restart();
    }
  }

  /**
   * Debounced reload �?coalesces multiple rapid config-change events into one
   * in-process reload when possible.
   */
  debouncedReload(delayMs?: number): void {
    void this.refreshReloadPolicy();
    const effectiveDelay = delayMs ?? this.reloadPolicy.debounceMs;
    if (this.reloadPolicy.mode === 'off' || this.reloadPolicy.mode === 'restart') {
      logger.debug(
        `Gateway reload policy=${this.reloadPolicy.mode}; routing debouncedReload to debouncedRestart (${effectiveDelay}ms)`,
      );
      this.debouncedRestart(effectiveDelay);
      return;
    }

    if (this.reloadDebounceTimer) {
      clearTimeout(this.reloadDebounceTimer);
    }
    logger.debug(`Gateway reload debounced (will fire in ${effectiveDelay}ms)`);
    this.reloadDebounceTimer = setTimeout(() => {
      this.reloadDebounceTimer = null;
      void this.reload().catch((err) => {
        logger.warn('Debounced Gateway reload failed:', err);
      });
    }, effectiveDelay);
  }

  private async refreshReloadPolicy(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.reloadPolicyLoadedAt < GatewayManager.RELOAD_POLICY_REFRESH_MS) {
      return;
    }

    if (this.reloadPolicyRefreshPromise) {
      await this.reloadPolicyRefreshPromise;
      return;
    }

    this.reloadPolicyRefreshPromise = (async () => {
      const nextPolicy = await loadGatewayReloadPolicy();
      this.reloadPolicy = nextPolicy;
      this.reloadPolicyLoadedAt = Date.now();
    })();

    try {
      await this.reloadPolicyRefreshPromise;
    } finally {
      this.reloadPolicyRefreshPromise = null;
    }
  }

  /**
   * Clear all active timers
   */
  private clearAllTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.connectionMonitor.clear();
    this.restartController.clearDebounceTimer();
    if (this.reloadDebounceTimer) {
      clearTimeout(this.reloadDebounceTimer);
      this.reloadDebounceTimer = null;
    }
    this.clearWarmupTimer();
    this.clearGatewayReadyFallback();
    for (const timer of this.terminalLockAuditTimersBySession.values()) {
      clearTimeout(timer);
    }
    this.terminalLockAuditTimersBySession.clear();
  }

  private clearWarmupTimer(): void {
    if (this.warmupTimer) {
      clearTimeout(this.warmupTimer);
      this.warmupTimer = null;
    }
  }

  private clearGatewayReadyFallback(): void {
    if (this.gatewayReadyFallbackTimer) {
      clearTimeout(this.gatewayReadyFallbackTimer);
      this.gatewayReadyFallbackTimer = null;
    }
  }

  private clearChatRunMetricTimers(run: {
    firstEventWatchdogTimers?: NodeJS.Timeout[];
    firstVisibleProgressWatchdogTimers?: NodeJS.Timeout[];
  }): void {
    if (run.firstEventWatchdogTimers) {
      for (const timer of run.firstEventWatchdogTimers) {
        clearTimeout(timer);
      }
      run.firstEventWatchdogTimers = undefined;
    }
    if (run.firstVisibleProgressWatchdogTimers) {
      for (const timer of run.firstVisibleProgressWatchdogTimers) {
        clearTimeout(timer);
      }
      run.firstVisibleProgressWatchdogTimers = undefined;
    }
  }

  private async settleTrackedUserRunsForGatewayStop(reason: string): Promise<void> {
    const trackedUserRuns = [...this.chatRunMetrics.entries()]
      .filter(([, run]) => run.kind === 'user');
    if (trackedUserRuns.length === 0) {
      return;
    }

    logger.warn('[gateway:chat-run] settling tracked user runs because gateway is stopping', {
      reason,
      runs: trackedUserRuns.map(([runId, run]) => ({
        runId,
        sessionKey: run.sessionKey,
        ageSinceAcceptedMs: Date.now() - run.acceptedAt,
      })),
    });

    for (const [runId, run] of trackedUserRuns) {
      this.clearChatRunMetricTimers(run);
      this.chatRunMetrics.delete(runId);

      try {
        await this.toolRunRegistry.cancelByRun(runId, reason);
      } catch (error) {
        logger.warn('[tool-run-registry] failed to cancel active tools for gateway stop', {
          reason,
          runId,
          sessionKey: run.sessionKey,
          error: String(error),
        });
      }

      this.emit('chat:message', {
        message: {
          state: 'aborted',
          runId,
          sessionKey: run.sessionKey,
          reason,
        },
      });
    }
  }

  private scheduleGatewayReadyFallback(): void {
    this.clearGatewayReadyFallback();
    this.gatewayReadyFallbackTimer = setTimeout(async () => {
      this.gatewayReadyFallbackTimer = null;
      if (this.status.state === 'running' && !this.status.gatewayReady) {
        if (this.hasInflightUserChatSend()) {
          logger.info('Gateway ready fallback deferred while user chat.send is pending');
          this.scheduleGatewayReadyFallback();
          return;
        }

        logger.info('Gateway ready fallback triggered; probing RPC router before marking ready');
        
        // 探测 RPC 路由器是否真的可�?
        try {
          await this.rpc('system-presence', {}, GatewayManager.GATEWAY_READY_PROBE_TIMEOUT_MS);
          logger.info('Gateway ready fallback RPC router probe succeeded');
          this.setStatus({ gatewayReady: true });
          this.warmupGateway();
        } catch (error) {
          logger.warn(`Gateway ready fallback RPC router probe failed: ${String(error)}`);
          // RPC 路由器还没就绪，不设�?gatewayReady
          // 前端会使用本地文件系统降�?
          if (this.status.state === 'running' && !this.status.gatewayReady) {
            this.scheduleGatewayReadyFallback();
          }
        }
      }
    }, GatewayManager.GATEWAY_READY_FALLBACK_MS);
  }

   /**
   * Warmup Gateway by triggering lazy initialization in background
   * The first chat message to any session triggers AI provider initialization (60+ seconds).
   * Subsequent messages to other sessions are fast because they reuse the initialized provider.
   * This warmup ensures the first user message will be fast.
   */
  private warmupGateway(): void {
    if (!GatewayManager.CHAT_WARMUP_ENABLED) {
      // Disable warmup - set status directly to 'ready' so frontend skips all warmup checks
      this.setStatus({ warmupStatus: 'ready' });
      logger.info('[perf:first-session] gateway.warmup.skipped', {
        reason: 'chat_warmup_disabled_by_env',
        envValue: process.env.LYCLAW_ENABLE_CHAT_WARMUP ?? null,
      });
      return;
    }

    if (this.skipWarmupAfterRestart) {
      this.skipWarmupAfterRestart = false;
      this.isWarmedUp = true;
      this.hasWarmupFailed = false;
      this.clearWarmupTimer();
      this.setStatus({ warmupStatus: 'ready' });
      logger.info('[perf:first-session] gateway.warmup.skipped', {
        reason: 'gateway_restarted',
      });
      return;
    }

    if (this.status.state !== 'running' || !this.status.gatewayReady) {
      logger.info('[perf:first-session] gateway.warmup.skipped', {
        reason: 'gateway_not_ready',
        state: this.status.state,
        gatewayReady: Boolean(this.status.gatewayReady),
      });
      return;
    }

    if (this.isWarmedUp || this.hasWarmupFailed || this.warmupTimer || this.warmupRequestPromise) {
      if (this.hasWarmupFailed && this.status.warmupStatus !== 'failed') {
        this.setStatus({ warmupStatus: 'failed' });
      }
      logger.info('[perf:first-session] gateway.warmup.already_active', {
        isWarmedUp: this.isWarmedUp,
        hasFailed: this.hasWarmupFailed,
        hasTimer: Boolean(this.warmupTimer),
        hasRequest: Boolean(this.warmupRequestPromise),
      });
      return;
    }

    if (this.hasInflightUserChatSend() || this.hasActiveUserChatRun()) {
      logger.info('[perf:first-session] gateway.warmup.skipped', {
        reason: 'user_chat_has_priority',
      });
      return;
    }

    // Start quickly after the Gateway is connected so normal users benefit
    // before their first message, while still giving the router a brief settle.
    logger.info('[perf:first-session] gateway.warmup.scheduled', {
      delayMs: GatewayManager.WARMUP_DELAY_MS,
      enabledByDefault: true,
      envValue: process.env.LYCLAW_ENABLE_CHAT_WARMUP ?? null,
    });
    this.warmupTimer = setTimeout(() => {
      this.warmupTimer = null;
      void this.runGatewayWarmup();
    }, GatewayManager.WARMUP_DELAY_MS);
  }

  private async runGatewayWarmup(): Promise<void> {
    if (this.isWarmedUp || this.hasWarmupFailed || this.warmupRequestPromise) {
      return this.warmupRequestPromise ?? Promise.resolve();
    }

    const warmupStart = Date.now();
    const warmupSessionKey = 'agent:main:__warmup__';
    this.warmupStartedAt = warmupStart;
    this.warmupRequestPromise = (async () => {
      try {
        logger.info('[perf:first-session] gateway.warmup.started');
        logger.info('Gateway warmup: triggering AI provider initialization with real chat request');
        this.setStatus({ warmupStatus: 'warming' });

        await ensureClawXContext();

        const crypto = await import('crypto');
        // Send a real chat request to trigger AI provider initialization.
        // The RPC returns when the run is accepted, so wait for completion
        // before declaring warmup complete.
        const warmupResult = await this.rpc('chat.send', {
          sessionKey: warmupSessionKey,
          sessionId: '__warmup__',
          message: '/think off 请只回复 ready。',
          deliver: true,
          idempotencyKey: crypto.randomUUID(),
        }, 120000);
        const warmupRunId = this.getRunIdFromRpcResult(warmupResult);
        if (!warmupRunId) {
          throw new Error('Warmup chat.send did not return runId');
        }
        logger.info('[perf:first-session] gateway.warmup.accepted', {
          runId: warmupRunId,
          acceptedMs: Date.now() - warmupStart,
        });
        if (this.status.state === 'running' && !this.status.gatewayReady) {
          this.setStatus({ gatewayReady: true });
        }
        const warmupFinalState = await this.waitForWarmupCompletion(warmupRunId);
        if (warmupFinalState !== 'final') {
          throw new Error(`Warmup run ended with ${warmupFinalState}`);
        }

        this.isWarmedUp = true;
        this.hasWarmupFailed = false;
        this.setStatus({ warmupStatus: 'ready' });
        logger.info('[perf:first-session] gateway.warmup.completed', {
          durationMs: Date.now() - warmupStart,
        });
        logger.info('Gateway warmup completed - AI provider is ready for user messages');
      } catch (error) {
        logger.warn('[perf:first-session] gateway.warmup.failed', {
          durationMs: Date.now() - warmupStart,
          error: String(error),
        });
        logger.warn(`Gateway warmup failed: ${String(error)}`);
        this.hasWarmupFailed = true;
        this.setStatus({ warmupStatus: 'failed' });
      } finally {
        this.warmupRequestPromise = null;
        this.warmupStartedAt = null;
      }
    })();

    await this.warmupRequestPromise;

    if (this.isWarmedUp) {
      setTimeout(() => {
        void this.cleanupWarmupSession(warmupSessionKey);
      }, GatewayManager.WARMUP_CLEANUP_DELAY_MS);
    }
  }

  private async cleanupWarmupSession(warmupSessionKey: string): Promise<void> {
    if (this.hasInflightUserChatSend() || this.hasActiveUserChatRun()) {
      logger.info('[perf:first-session] gateway.warmup.cleanup.deferred', {
        reason: 'user_chat_has_priority',
        delayMs: 30_000,
      });
      setTimeout(() => {
        void this.cleanupWarmupSession(warmupSessionKey);
      }, 30_000);
      return;
    }

    try {
      logger.info('[perf:first-session] gateway.warmup.cleanup.started', {
        delayMs: GatewayManager.WARMUP_CLEANUP_DELAY_MS,
      });
      await this.rpc('sessions.delete', { key: warmupSessionKey }, 5000);
      logger.info('Gateway warmup: cleaned up warmup session');
    } catch (cleanupError) {
      logger.warn('Gateway warmup: failed to cleanup warmup session:', cleanupError);
    }
  }

  private isWarmupChatSend(method: string, params?: unknown): boolean {
    return method === 'chat.send'
      && Boolean(params)
      && typeof params === 'object'
      && (params as { sessionKey?: unknown }).sessionKey === 'agent:main:__warmup__';
  }

  private isInternalToolFeedbackChatSend(method: string, params?: unknown): boolean {
    if (method !== 'chat.send' || !params || typeof params !== 'object') return false;
    const message = (params as { message?: unknown }).message;
    return typeof message === 'string' && (
      message.trim().startsWith('[LYCLAW internal tool failure feedback]')
      || message.trim().startsWith('[LYCLAW internal convergence directive]')
    );
  }

  private getExecuteAsAgentId(method: string, params?: unknown): string | null {
    if (method !== 'chat.send' || !params || typeof params !== 'object') return null;
    const value = (params as { executeAsAgentId?: unknown }).executeAsAgentId;
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private async warnIfDigitalEmployeeIsolationMissing(method: string, params?: unknown): Promise<void> {
    const executeAsAgentId = this.getExecuteAsAgentId(method, params);
    if (!executeAsAgentId) return;
    const isolationStatus = await inspectOpenClawDigitalEmployeeIsolation();
    if (isolationStatus.ok) return;
    logger.warn('[digital-employee-isolation] chat.send is executing a digital employee but the active OpenClaw runtime is missing isolation markers; execution is not blocked by policy.', {
      executeAsAgentId,
      openclawDir: isolationStatus.openclawDir,
      missing: isolationStatus.missing,
      details: isolationStatus.details,
    });
  }

  private isUserChatSend(method: string, params?: unknown): boolean {
    return method === 'chat.send'
      && !this.isWarmupChatSend(method, params)
      && !this.isInternalToolFeedbackChatSend(method, params)
      && !this.isCronChatSend(params);
  }

  private isCronChatSend(params?: unknown): boolean {
    if (!params || typeof params !== 'object') return false;
    const sessionKey = (params as { sessionKey?: unknown }).sessionKey;
    return typeof sessionKey === 'string' && (
      sessionKey.includes(':cron:')
      || sessionKey.includes(':cron-run:')
      || sessionKey.includes(':scheduled-task:')
    );
  }

  private hasInflightUserChatSend(): boolean {
    return [...this.rpcInflight.values()].some((rpc) =>
      rpc.method === 'chat.send' && rpc.sessionKey !== 'agent:main:__warmup__'
    );
  }

  private hasActiveUserChatRun(): boolean {
    return [...this.chatRunMetrics.values()].some((run) => run.kind === 'user');
  }

  private getTrackedUserRunsForSession(sessionKey: string | undefined): Array<[string, ChatRunMetric]> {
    const key = sessionKey?.trim();
    if (!key) return [];
    return [...this.chatRunMetrics.entries()]
      .filter(([, run]) => run.kind === 'user' && run.sessionKey === key);
  }

  private settleTrackedUserRunLocally(
    runId: string,
    run: ChatRunMetric,
    reason: string,
  ): void {
    this.clearChatRunMetricTimers(run);
    this.chatRunMetrics.delete(runId);
    logger.warn('[gateway:chat-run] settling tracked user run before new message', {
      reason,
      runId,
      sessionKey: run.sessionKey,
      ageSinceAcceptedMs: Date.now() - run.acceptedAt,
      ageSinceRequestedMs: Date.now() - run.requestedAt,
      hasFirstDelta: Boolean(run.firstDeltaAt),
      hasFirstVisibleProgress: Boolean(run.firstVisibleProgressAt),
    });
    this.emit('chat:message', {
      message: {
        state: 'aborted',
        runId,
        sessionKey: run.sessionKey,
        reason,
      },
    });
  }

  private getChatSendSessionKey(params?: unknown): string | undefined {
    if (!params || typeof params !== 'object') {
      return undefined;
    }
    const sessionKey = (params as { sessionKey?: unknown }).sessionKey;
    return typeof sessionKey === 'string' ? sessionKey : undefined;
  }

  private getRpcSessionKey(method: string, params?: unknown): string | undefined {
    if (!params || typeof params !== 'object') {
      return undefined;
    }
    const p = params as { sessionKey?: unknown; key?: unknown };
    const value = method === 'sessions.delete' || method === 'sessions.abort' || method === 'sessions.patch'
      ? (p.key ?? p.sessionKey)
      : p.sessionKey;
    return typeof value === 'string' ? value : undefined;
  }

  private getInflightRpcSnapshot(now = Date.now()): Array<{
    id: string;
    method: string;
    ageMs: number;
    timeoutMs: number;
    sessionKey?: string;
  }> {
    return [...this.rpcInflight.entries()]
      .map(([id, rpc]) => ({
        id,
        method: rpc.method,
        ageMs: now - rpc.startedAt,
        timeoutMs: rpc.timeoutMs,
        sessionKey: rpc.sessionKey,
      }))
      .sort((a, b) => b.ageMs - a.ageMs)
      .slice(0, 20);
  }

  private getTrackedChatRunSnapshot(now = Date.now()): TrackedChatRunSnapshot {
    return [...this.chatRunMetrics.entries()].map(([runId, run]) => ({
      runId,
      kind: run.kind,
      sessionKey: run.sessionKey,
      ageSinceAcceptedMs: now - run.acceptedAt,
      ageSinceRequestedMs: now - run.requestedAt,
      hasFirstDelta: Boolean(run.firstDeltaAt),
      hasFirstVisibleProgress: Boolean(run.firstVisibleProgressAt),
      firstVisibleProgressKind: run.firstVisibleProgressKind,
    })).slice(0, 20);
  }

  private async getPathStatSnapshot(filePath: string): Promise<{
    path: string;
    exists: boolean;
    sizeBytes?: number;
    mtimeMs?: number;
    error?: string;
  }> {
    try {
      const stats = await stat(filePath);
      return {
        path: filePath,
        exists: true,
        sizeBytes: stats.size,
        mtimeMs: Math.round(stats.mtimeMs),
      };
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      if (code === 'ENOENT') {
        return { path: filePath, exists: false };
      }
      return { path: filePath, exists: false, error: String(error) };
    }
  }

  private async readJsonSnapshot<T>(filePath: string): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
    try {
      return { ok: true, value: JSON.parse(await readFile(filePath, 'utf8')) as T };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  }

  private isPidAlive(pid: unknown): boolean | null {
    if (!Number.isInteger(pid) || (pid as number) <= 0) return null;
    try {
      process.kill(pid as number, 0);
      return true;
    } catch {
      return false;
    }
  }

  private getSessionDiagnosticsPaths(sessionKey?: string): string[] {
    const openclawDir = path.join(homedir(), '.openclaw');
    const agentId = sessionKey?.startsWith('agent:')
      ? sessionKey.split(':')[1] || 'main'
      : 'main';
    const sessionId = sessionKey?.startsWith('agent:')
      ? sessionKey.split(':')[2]
      : undefined;
    const sessionsDir = path.join(openclawDir, 'agents', agentId, 'sessions');
    const paths = [
      path.join(sessionsDir, 'sessions.json'),
      path.join(sessionsDir, 'sessions.json.lock'),
    ];
    if (sessionId && sessionId !== 'main') {
      paths.push(path.join(sessionsDir, `${sessionId}.jsonl`));
    }
    return paths;
  }

  private async getEmptyFinalSessionSnapshot(sessionKey?: string): Promise<Record<string, unknown>> {
    const openclawDir = path.join(homedir(), '.openclaw');
    const agentId = sessionKey?.startsWith('agent:')
      ? sessionKey.split(':')[1] || 'main'
      : 'main';
    const sessionsDir = path.join(openclawDir, 'agents', agentId, 'sessions');
    const sessionsJsonPath = path.join(sessionsDir, 'sessions.json');
    const sessionFiles = await Promise.all(
      this.getSessionDiagnosticsPaths(sessionKey).map((filePath) => this.getPathStatSnapshot(filePath)),
    );

    const snapshot: Record<string, unknown> = {
      sessionFiles,
    };

    if (!sessionKey) {
      return snapshot;
    }

    const sessionsJson = await this.readJsonSnapshot<Record<string, { sessionFile?: unknown; status?: unknown }>>(sessionsJsonPath);
    if (!sessionsJson.ok) {
      snapshot.sessionStoreReadError = sessionsJson.error;
      return snapshot;
    }

    const sessionEntry = sessionsJson.value[sessionKey];
    snapshot.sessionStoreEntry = sessionEntry
      ? {
        status: sessionEntry.status,
        sessionFile: sessionEntry.sessionFile,
      }
      : null;

    const rawSessionFile = typeof sessionEntry?.sessionFile === 'string' ? sessionEntry.sessionFile : '';
    if (!rawSessionFile) {
      return snapshot;
    }

    const transcriptPath = path.isAbsolute(rawSessionFile)
      ? rawSessionFile
      : path.join(sessionsDir, rawSessionFile);
    const lockPath = `${transcriptPath}.lock`;
    const [transcriptStat, lockStat] = await Promise.all([
      this.getPathStatSnapshot(transcriptPath),
      this.getPathStatSnapshot(lockPath),
    ]);
    snapshot.transcriptFile = transcriptStat;
    snapshot.transcriptLock = lockStat;

    if (lockStat.exists) {
      const lockOwner = await this.readJsonSnapshot<{ pid?: unknown; createdAt?: unknown }>(lockPath);
      if (lockOwner.ok) {
        const createdAtMs = typeof lockOwner.value.createdAt === 'string'
          ? Date.parse(lockOwner.value.createdAt)
          : NaN;
        snapshot.transcriptLockOwner = {
          pid: lockOwner.value.pid,
          createdAt: lockOwner.value.createdAt,
          lockAgeMs: Number.isFinite(createdAtMs) ? Math.max(0, Date.now() - createdAtMs) : null,
          pidAlive: this.isPidAlive(lockOwner.value.pid),
          currentGatewayPid: this.process?.pid ?? this.status.pid ?? process.pid,
        };
      } else {
        snapshot.transcriptLockOwner = { readError: lockOwner.error };
      }
    }

    return snapshot;
  }

  private scheduleChatSendWatchdog(args: {
    requestId: string;
    method: string;
    params?: unknown;
    rpcStart: number;
  }): NodeJS.Timeout[] {
    if (!this.isUserChatSend(args.method, args.params)) {
      return [];
    }

    const sessionKey = this.getRpcSessionKey(args.method, args.params);
    return this.chatSendWatchdogDelaysMs.map((delayMs) => setTimeout(() => {
      if (!this.rpcInflight.has(args.requestId)) {
        return;
      }
      void (async () => {
        const now = Date.now();
        const fileStats = await Promise.all(
          this.getSessionDiagnosticsPaths(sessionKey).map((filePath) => this.getPathStatSnapshot(filePath)),
        );
        logger.info('[perf:chat-send-pending]', {
          requestId: args.requestId,
          method: args.method,
          sessionKey,
          pendingMs: now - args.rpcStart,
          watchdogDelayMs: delayMs,
          inflightRpcCount: this.rpcInflight.size,
          inflightRpcs: this.getInflightRpcSnapshot(now),
          trackedChatRuns: this.getTrackedChatRunSnapshot(now),
          recentGatewayStderr: this.recentStartupStderrLines.slice(-20),
          sessionFiles: fileStats,
        });
        // recordChatSendPending({
        //   requestId: args.requestId,
        //   pendingMs: now - args.rpcStart,
        //   watchdogDelayMs: delayMs,
        //   sessionKey,
        // });
      })();
    }, delayMs));
  }

  private parseGatewayDebugStdoutLine(line: string): void {
    const jsonStart = line.indexOf('{');
    if (jsonStart < 0) {
      return;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line.slice(jsonStart)) as Record<string, unknown>;
    } catch {
      return;
    }

    if (line.includes('[DEBUG-sessionId]')) {
      const sid = typeof parsed.sid === 'string' ? parsed.sid : undefined;
      const provider = typeof parsed.provider === 'string' ? parsed.provider : undefined;
      if (sid) {
        this.lastGatewayDebugSessionId = sid;
      }
      if (provider) {
        this.lastGatewayDebugProvider = provider;
      }
      return;
    }

    if (!line.includes('[DEBUG-usage]')) {
      return;
    }

    const usage = parsed.parsed && typeof parsed.parsed === 'object'
      ? parsed.parsed as Record<string, unknown>
      : parsed;
    // recordGatewayModelUsage({
    //   sessionId: this.lastGatewayDebugSessionId,
    //   provider: this.lastGatewayDebugProvider,
    //   input: typeof usage.input === 'number' ? usage.input : undefined,
    //   output: typeof usage.output === 'number' ? usage.output : undefined,
    //   cacheRead: typeof usage.cacheRead === 'number' ? usage.cacheRead : undefined,
    //   totalTokens: typeof usage.totalTokens === 'number' ? usage.totalTokens : undefined,
    // });
  }

  private scheduleChatRunFirstEventWatchdog(runId: string): NodeJS.Timeout[] {
    return this.chatRunFirstEventWatchdogDelaysMs.map((delayMs) => setTimeout(() => {
      const metrics = this.chatRunMetrics.get(runId);
      if (!metrics || metrics.firstEventAt) {
        return;
      }

      void (async () => {
        const now = Date.now();
        const fileStats = await Promise.all(
          this.getSessionDiagnosticsPaths(metrics.sessionKey).map((filePath) => this.getPathStatSnapshot(filePath)),
        );
        logger.info('[perf:chat-run-pending-first-event]', {
          kind: metrics.kind,
          runId,
          sessionKey: metrics.sessionKey,
          pendingSinceAcceptedMs: now - metrics.acceptedAt,
          pendingSinceRequestedMs: now - metrics.requestedAt,
          watchdogDelayMs: delayMs,
          rpcDurationMs: metrics.rpcDurationMs,
          inflightRpcCount: this.rpcInflight.size,
          inflightRpcs: this.getInflightRpcSnapshot(now),
          trackedChatRuns: this.getTrackedChatRunSnapshot(now),
          recentGatewayStderr: this.recentStartupStderrLines.slice(-20),
          sessionFiles: fileStats,
        });
        // recordChatRunPending({
        //   kind: 'first_event',
        //   runId,
        //   pendingMs: now - metrics.acceptedAt,
        //   watchdogDelayMs: delayMs,
        //   sessionKey: metrics.sessionKey,
        // });
      })();
    }, delayMs));
  }

  private scheduleChatRunFirstVisibleProgressWatchdog(runId: string): NodeJS.Timeout[] {
    return this.chatRunFirstVisibleProgressWatchdogDelaysMs.map((delayMs) => setTimeout(() => {
      const metrics = this.chatRunMetrics.get(runId);
      if (!metrics || metrics.firstVisibleProgressAt) {
        return;
      }

      void (async () => {
        const now = Date.now();
        const fileStats = await Promise.all(
          this.getSessionDiagnosticsPaths(metrics.sessionKey).map((filePath) => this.getPathStatSnapshot(filePath)),
        );
        logger.info('[perf:chat-run-pending-first-visible-progress]', {
          kind: metrics.kind,
          runId,
          sessionKey: metrics.sessionKey,
          pendingSinceAcceptedMs: now - metrics.acceptedAt,
          pendingSinceRequestedMs: now - metrics.requestedAt,
          watchdogDelayMs: delayMs,
          rpcDurationMs: metrics.rpcDurationMs,
          firstEventAt: metrics.firstEventAt ? metrics.firstEventAt - metrics.acceptedAt : null,
          firstDeltaAt: metrics.firstDeltaAt ? metrics.firstDeltaAt - metrics.acceptedAt : null,
          inflightRpcCount: this.rpcInflight.size,
          inflightRpcs: this.getInflightRpcSnapshot(now),
          trackedChatRuns: this.getTrackedChatRunSnapshot(now),
          recentGatewayStderr: this.recentStartupStderrLines.slice(-20),
          sessionFiles: fileStats,
        });
        // recordChatRunPending({
        //   kind: 'first_visible_progress',
        //   runId,
        //   pendingMs: now - metrics.acceptedAt,
        //   watchdogDelayMs: delayMs,
        //   sessionKey: metrics.sessionKey,
        // });
      })();
    }, delayMs));
  }

  private classifyVisibleProgress(message: unknown): { visible: boolean; kind: string; messageBlockTypes: string[] } {
    if (!message || typeof message !== 'object') {
      return { visible: false, kind: 'none', messageBlockTypes: [] };
    }
    const msg = message as Record<string, unknown>;
    const messageBlockTypes: string[] = [];
    const content = msg.content;
    if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (typeof block.type === 'string') messageBlockTypes.push(block.type);
      }
    }
    if (Array.isArray(msg.tool_calls)) messageBlockTypes.push('tool_calls');
    if (Array.isArray(msg.toolCalls)) messageBlockTypes.push('toolCalls');

    const role = typeof msg.role === 'string' ? msg.role.toLowerCase() : '';
    if (role === 'toolresult' || role === 'tool_result') {
      return { visible: true, kind: 'tool_result', messageBlockTypes };
    }
    if (typeof content === 'string') {
      return content.trim()
        ? { visible: true, kind: 'assistant_text', messageBlockTypes }
        : { visible: false, kind: 'placeholder', messageBlockTypes };
    }
    const toolCalls = msg.tool_calls ?? msg.toolCalls;
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      return { visible: true, kind: 'tool_use', messageBlockTypes };
    }
    if (!Array.isArray(content)) {
      return Object.keys(msg).length > 0
        ? { visible: false, kind: 'placeholder', messageBlockTypes }
        : { visible: false, kind: 'none', messageBlockTypes };
    }

    let hasThinkingBlock = false;
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        return { visible: true, kind: 'assistant_text', messageBlockTypes };
      }
      if (block.type === 'thinking') {
        hasThinkingBlock = true;
        if (typeof block.thinking === 'string' && block.thinking.trim()) {
          return { visible: true, kind: 'thinking_text', messageBlockTypes };
        }
      }
      if (block.type === 'tool_use' || block.type === 'toolCall') {
        return { visible: true, kind: 'tool_use', messageBlockTypes };
      }
      if (block.type === 'tool_result' || block.type === 'toolResult') {
        return { visible: true, kind: 'tool_result', messageBlockTypes };
      }
      if (block.type === 'image') {
        return { visible: true, kind: 'image', messageBlockTypes };
      }
    }
    if (hasThinkingBlock) {
      return { visible: true, kind: 'thinking_block', messageBlockTypes };
    }
    return { visible: false, kind: 'placeholder', messageBlockTypes };
  }

  private recordSessionWriteLockLog(line: string): void {
    const parsed = parseSessionWriteLockLog(line);
    if (!parsed) {
      return;
    }

    const now = Date.now();
    logger.info('[perf:session-lock]', {
      phase: parsed.phase,
      path: parsed.path,
      heldMs: parsed.heldMs,
      maxMs: parsed.maxMs,
      waitedMs: parsed.waitedMs,
      inflightRpcCount: this.rpcInflight.size,
      inflightRpcs: this.getInflightRpcSnapshot(now),
      trackedChatRuns: this.getTrackedChatRunSnapshot(now),
      raw: parsed.raw,
    });
  }

  private recordStuckSessionDiagnostic(line: string): void {
    const diagnostic = parseGatewayStuckSessionDiagnostic(line);
    if (!diagnostic) {
      return;
    }

    this.diagnostics.lastStuckSessionAt = Date.now();
    this.diagnostics.lastStuckSession = diagnostic;
    this.setStatus({
      lastStuckSessionAt: this.diagnostics.lastStuckSessionAt,
      lastStuckSession: diagnostic,
    });
  }

  private async recordEmptyUserChatFinalDiagnostic(args: {
    runId: string;
    sessionKey?: string;
    totalSinceAcceptedMs: number;
    totalSinceRequestedMs: number;
    timeToFirstEventMs: number | null;
    timeToFirstDeltaMs: number | null;
    timeToFirstVisibleProgressMs: number | null;
    firstVisibleProgressKind?: string;
    rpcDurationMs: number;
    trackedChatRunsBeforeCompletion: TrackedChatRunSnapshot;
  }): Promise<void> {
    const [sessionSnapshot, recoveryResult] = await Promise.all([
      this.getEmptyFinalSessionSnapshot(args.sessionKey),
      this.recoverSessionTranscriptLock(args.sessionKey, 'empty-user-chat-final'),
    ]);

    const diagnostic: EmptyFinalDiagnostic = {
      ...args,
      recordedAt: Date.now(),
      gatewayPid: this.process?.pid ?? this.status.pid ?? process.pid,
      recoveryResult,
      ...sessionSnapshot,
    };
    if (args.sessionKey) {
      this.emptyFinalDiagnosticsBySession.set(args.sessionKey, diagnostic);
    }

    logger.warn('[gateway:session-lock-recovery] user chat run completed without a message', diagnostic);
  }

  getLatestEmptyFinalDiagnostic(sessionKey: string | null | undefined): EmptyFinalDiagnostic | null {
    const key = sessionKey?.trim();
    if (!key) return null;
    return this.emptyFinalDiagnosticsBySession.get(key) ?? null;
  }

  hasTrackedUserRunForSession(sessionKey: string | null | undefined): boolean {
    const key = sessionKey?.trim();
    if (!key) return false;
    return [...this.chatRunMetrics.values()].some((run) => run.kind === 'user' && run.sessionKey === key);
  }

  private getTrackedUserRunIdsForSession(sessionKey: string): string[] {
    return [...this.chatRunMetrics.entries()]
      .filter(([, run]) => run.kind === 'user' && run.sessionKey === sessionKey)
      .map(([runId]) => runId);
  }

  private static readonly ACTIVE_SESSION_STATUSES = new Set(['running', 'processing', 'queued', 'pending']);

  private isActiveSessionStatus(status: unknown): boolean {
    return typeof status === 'string'
      && GatewayManager.ACTIVE_SESSION_STATUSES.has(status.toLowerCase());
  }

  /** Heartbeat/cron lane — resident background work, not user-visible background tasks. */
  private isHeartbeatSessionKey(sessionKey: string): boolean {
    const parts = sessionKey.split(':');
    return parts.length === 3 && parts[0] === 'agent' && parts[2] === 'main';
  }

  /**
   * The agent main session is also used for OpenClaw heartbeat polls. Those
   * polls update sessions.json to `processing`, but they are internal work and
   * their terminal chat events are intentionally suppressed before reaching the
   * renderer. If backend-activity exposes that weak processing signal, the UI
   * can re-adopt/keep a stale run and only clear when the user presses stop.
   */
  private async isLatestSessionUserTurnHeartbeat(
    sessionKey: string,
    sessionsJsonPath: string,
    sessions: Record<string, { sessionFile?: unknown }>,
  ): Promise<boolean> {
    const rawSessionFile = sessions[sessionKey]?.sessionFile;
    if (typeof rawSessionFile !== 'string' || !rawSessionFile.trim()) return false;

    const transcriptPath = path.isAbsolute(rawSessionFile)
      ? rawSessionFile
      : path.join(path.dirname(sessionsJsonPath), rawSessionFile);

    let raw: string;
    try {
      raw = await readFile(transcriptPath, 'utf8');
    } catch {
      return false;
    }

    const lines = raw.split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      let record: unknown;
      try {
        record = JSON.parse(lines[i]!);
      } catch {
        continue;
      }
      if (!record || typeof record !== 'object') continue;
      const message = (record as Record<string, unknown>).message;
      if (!message || typeof message !== 'object') continue;
      const role = this.getMessageRole(message).toLowerCase();
      if (role !== 'user') continue;
      return this.isInternalHeartbeatMessage(message);
    }
    return false;
  }

  private getGatewayProcessPid(): number {
    return this.process?.pid ?? this.status.pid ?? process.pid;
  }

  private async listAgentIds(): Promise<string[]> {
    const agentsDir = path.join(homedir(), '.openclaw', 'agents');
    try {
      const entries = await readdir(agentsDir, { withFileTypes: true });
      const ids = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
      return ids.length > 0 ? ids : ['main'];
    } catch {
      return ['main'];
    }
  }

  private async isSessionLiveOnBackend(sessionKey: string, hasTrackedActiveRun: boolean): Promise<boolean> {
    if (hasTrackedActiveRun) return true;

    const [diskLive, execLive] = await Promise.all([
      isSessionProcessingLiveOnDisk({
        sessionKey,
        hasTrackedActiveRun: false,
        currentPid: this.getGatewayProcessPid(),
      }),
      hasActiveExecInSessionTranscript({ sessionKey }),
    ]);

    return diskLive || execLive;
  }

  async getSessionActivity(sessionKey: string | null | undefined): Promise<{
    sessionKey: string;
    status: string | null;
    processing: boolean;
    hasTrackedUserRun: boolean;
    activeRunIds: string[];
  }> {
    const key = sessionKey?.trim() ?? '';
    const activeRunIds = key ? this.getTrackedUserRunIdsForSession(key) : [];
    const hasTrackedUserRun = activeRunIds.length > 0;

    if (!key || !key.startsWith('agent:')) {
      return {
        sessionKey: key,
        status: null,
        processing: hasTrackedUserRun,
        hasTrackedUserRun,
        activeRunIds,
      };
    }

    const agentId = key.split(':')[1] || 'main';
    const sessionsJsonPath = path.join(homedir(), '.openclaw', 'agents', agentId, 'sessions', 'sessions.json');
    const sessionsJson = await this.readJsonSnapshot<Record<string, { sessionFile?: unknown; status?: unknown }>>(sessionsJsonPath);
    const status = sessionsJson.ok && sessionsJson.value[key]?.status != null
      ? String(sessionsJson.value[key].status)
      : null;
    const internalHeartbeatOnly = !hasTrackedUserRun
      && this.isHeartbeatSessionKey(key)
      && sessionsJson.ok
      && await this.isLatestSessionUserTurnHeartbeat(key, sessionsJsonPath, sessionsJson.value);
    const processing = internalHeartbeatOnly
      ? false
      : hasTrackedUserRun || await this.isSessionLiveOnBackend(key, hasTrackedUserRun);

    return {
      sessionKey: key,
      status,
      processing,
      hasTrackedUserRun,
      activeRunIds,
    };
  }

  async getGatewayBackgroundActivity(currentSessionKey?: string | null): Promise<{
    hasBackgroundProcessing: boolean;
    processingSessionKeys: string[];
  }> {
    const processingSessionKeys = new Set<string>();

    for (const run of this.chatRunMetrics.values()) {
      if (run.kind !== 'user' || !run.sessionKey) continue;
      if (this.isHeartbeatSessionKey(run.sessionKey)) continue;
      processingSessionKeys.add(run.sessionKey);
    }

    const agentIds = await this.listAgentIds();

    for (const agentId of agentIds) {
      const sessionsJsonPath = path.join(homedir(), '.openclaw', 'agents', agentId, 'sessions', 'sessions.json');
      const sessionsJson = await this.readJsonSnapshot<Record<string, { status?: unknown }>>(sessionsJsonPath);
      if (!sessionsJson.ok) continue;

      const candidateKeys: string[] = [];
      for (const [sessionKey, entry] of Object.entries(sessionsJson.value)) {
        if (sessionKey === 'sessions') continue;
        if (this.isHeartbeatSessionKey(sessionKey)) continue;
        if (processingSessionKeys.has(sessionKey)) continue;
        if (this.isActiveSessionStatus(entry?.status)) {
          candidateKeys.push(sessionKey);
        }
      }

      const liveKeys = await Promise.all(candidateKeys.map(async (sessionKey) => {
        const hasTracked = this.hasTrackedUserRunForSession(sessionKey);
        const live = await this.isSessionLiveOnBackend(sessionKey, hasTracked);
        return live ? sessionKey : null;
      }));

      for (const sessionKey of liveKeys) {
        if (sessionKey) processingSessionKeys.add(sessionKey);
      }
    }

    if (currentSessionKey?.trim()) {
      const current = currentSessionKey.trim();
      if (!this.isHeartbeatSessionKey(current)) {
        const hasTracked = this.hasTrackedUserRunForSession(current);
        if (hasTracked || await this.isSessionLiveOnBackend(current, hasTracked)) {
          processingSessionKeys.add(current);
        }
      }
    }

    const keys = [...processingSessionKeys];
    return {
      hasBackgroundProcessing: keys.length > 0,
      processingSessionKeys: keys,
    };
  }

  async recoverStaleSessionAfterEmptyFinal(sessionKey: string | null | undefined): Promise<StaleSessionRecoveryResult> {
    const key = sessionKey?.trim();
    if (!key) {
      return { ok: true, recovered: false, sessionKey: '', reason: 'missing-session-key' };
    }
    const diagnostic = this.getLatestEmptyFinalDiagnostic(key);
    const owner = diagnostic?.transcriptLockOwner as Record<string, unknown> | undefined;
    const lastProgressAt = typeof diagnostic?.recordedAt === 'number' && diagnostic.timeToFirstVisibleProgressMs != null
      ? diagnostic.recordedAt
      : null;

    return await recoverStaleSessionAfterEmptyFinal({
      sessionKey: key,
      openclawDir: path.join(homedir(), '.openclaw'),
      currentPid: this.process?.pid ?? this.status.pid ?? process.pid,
      hasRecentEmptyFinalNoOutput: Boolean(diagnostic),
      hasTrackedActiveRun: this.hasTrackedUserRunForSession(key),
      lastVisibleProgressAt: lastProgressAt,
      logger,
    }).then((result) => {
      if (result.ok && result.recovered) {
        this.emptyFinalDiagnosticsBySession.delete(key);
      }
      return {
        ...result,
        ...(result.ok && !result.recovered && owner ? { details: { ...(result.details ?? {}), lastLockOwner: owner } } : {}),
      } as StaleSessionRecoveryResult;
    });
  }

  private getRunIdFromRpcResult(result: unknown): string | null {
    if (!result || typeof result !== 'object') {
      return null;
    }
    const runId = (result as { runId?: unknown }).runId;
    return typeof runId === 'string' && runId.trim() ? runId : null;
  }

  private waitForWarmupCompletion(runId: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const timeout = setTimeout(() => {
        this.warmupRunWaiters.delete(runId);
        reject(new Error(`Warmup completion timeout after ${Date.now() - startedAt}ms`));
      }, GatewayManager.WARMUP_FIRST_OUTPUT_TIMEOUT_MS);

      this.warmupRunWaiters.set(runId, {
        resolve,
        reject,
        timeout,
        startedAt,
      });
    });
  }

  private resolveWarmupCompletion(runId: string, state: string): void {
    const waiter = this.warmupRunWaiters.get(runId);
    if (!waiter) {
      return;
    }

    clearTimeout(waiter.timeout);
    this.warmupRunWaiters.delete(runId);
    logger.info('[perf:first-session] gateway.warmup.run_completed', {
      runId,
      state,
      waitedMs: Date.now() - waiter.startedAt,
    });
    waiter.resolve(state);
  }

  private getMessageRole(message: unknown): string {
    if (!message || typeof message !== 'object') return '';
    const role = (message as Record<string, unknown>).role;
    return typeof role === 'string' ? role : '';
  }

  private getMessageTextContent(message: unknown): string {
    if (!message || typeof message !== 'object') return '';
    const content = (message as Record<string, unknown>).content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .map((block) => {
        if (!block || typeof block !== 'object') return '';
        const text = (block as Record<string, unknown>).text;
        return typeof text === 'string' ? text : '';
      })
      .filter(Boolean)
      .join('\n');
  }

  private getToolResultDetails(message: unknown): Record<string, unknown> {
    if (!message || typeof message !== 'object') return {};
    const details = (message as Record<string, unknown>).details;
    return details && typeof details === 'object' ? details as Record<string, unknown> : {};
  }

  private getToolCallId(message: unknown): string {
    if (!message || typeof message !== 'object') return '';
    const value = (message as Record<string, unknown>).toolCallId
      ?? (message as Record<string, unknown>).tool_call_id;
    return typeof value === 'string' ? value : '';
  }

  private getToolName(message: unknown): string {
    if (!message || typeof message !== 'object') return 'tool';
    const value = (message as Record<string, unknown>).toolName
      ?? (message as Record<string, unknown>).name;
    return typeof value === 'string' && value.trim() ? value : 'tool';
  }

  private parseToolHandle(message: unknown): ToolRunHandle | null {
    const details = this.getToolResultDetails(message);
    const text = this.getMessageTextContent(message);
    const sessionId = typeof details.sessionId === 'string'
      ? details.sessionId
      : (text.match(/session\s+([A-Za-z0-9_-]+)/i)?.[1] ?? '');
    const rawPid = typeof details.pid === 'number'
      ? details.pid
      : Number(text.match(/pid\s+(\d+)/i)?.[1] ?? NaN);
    if (!sessionId && !Number.isFinite(rawPid)) return null;
    return {
      kind: 'process',
      id: sessionId || String(rawPid),
      ...(Number.isFinite(rawPid) ? { pid: rawPid } : {}),
    };
  }

  private isRunningToolResult(message: unknown): boolean {
    const role = this.getMessageRole(message).toLowerCase();
    if (role !== 'toolresult' && role !== 'tool_result') return false;
    const details = this.getToolResultDetails(message);
    if (details.status === 'running') return true;
    return /Command still running/i.test(this.getMessageTextContent(message));
  }

  private observeToolRunFromChatEvent(event: GatewayChatEvent, sessionKey?: string): void {
    const runId = typeof event.runId === 'string' ? event.runId : null;
    const message = event.message;
    const role = this.getMessageRole(message).toLowerCase();
    if (role !== 'toolresult' && role !== 'tool_result') return;

    if (this.isRunningToolResult(message)) {
      const handle = this.parseToolHandle(message);
      const details = this.getToolResultDetails(message);
      const startedAt = typeof details.startedAt === 'number' ? details.startedAt : undefined;
      this.toolRunRegistry.registerRunningTool({
        owner: this.isInternalHeartbeatMessage(message) ? 'internal-heartbeat' : 'user-run',
        visible: !this.isInternalHeartbeatMessage(message),
        sessionKey: sessionKey ?? 'unknown',
        runId,
        toolCallId: this.getToolCallId(message) || `${this.getToolName(message)}:${handle?.id ?? Date.now()}`,
        toolName: this.getToolName(message),
        startedAt,
        handle: handle ?? undefined,
        message: this.getMessageTextContent(message),
      });
      return;
    }

    const details = this.getToolResultDetails(message);
    const status = typeof details.status === 'string' ? details.status.toLowerCase() : '';
    const text = this.getMessageTextContent(message);
    const handle = this.parseToolHandle(message);
    const toolCallId = this.getToolCallId(message);
    const candidates = [
      ...(runId ? this.toolRunRegistry.findByRun(runId) : []),
      ...this.toolRunRegistry.findByHandle(handle),
    ].filter((record, index, all) => (
      all.findIndex((item) => item.toolRunId === record.toolRunId) === index
    ));
    const terminalStatus = status === 'error' || status === 'failed' || /\(Command exited with code [1-9]\d*\)/i.test(text)
      ? 'failed'
      : status === 'completed' || status === 'done' || /\(Command exited with code 0\)/i.test(text)
        ? 'completed'
        : null;
    if (!terminalStatus) {
      for (const record of candidates) {
        if (toolCallId && record.toolCallId !== toolCallId) continue;
        this.toolRunRegistry.markProgress(record.toolRunId, { message: text });
      }
      return;
    }
    for (const record of candidates) {
      if (toolCallId && record.toolCallId !== toolCallId) continue;
      this.toolRunRegistry.markTerminal(record.toolRunId, terminalStatus, terminalStatus);
      if (terminalStatus === 'completed') {
        void this.toolRunRegistry.cleanupCompletedToolRun(record.toolRunId, 'completed').catch((error) => {
          logger.warn('[tool-run-registry] cleanup completed tool failed', {
            toolRunId: record.toolRunId,
            error: String(error),
          });
        });
      }
    }
  }

  private isInternalHeartbeatMessage(message: unknown): boolean {
    const text = this.getMessageTextContent(message).trim();
    return /^(HEARTBEAT_OK|NO_REPLY)$/i.test(text)
      || /^\[?OpenClaw heartbeat poll\]?$/i.test(text);
  }

  private async cleanupToolRun(record: ToolRunRecord, reason: string): Promise<{ ok: boolean; unsupported?: boolean; error?: string }> {
    if (!record.handle || record.handle.kind !== 'process') {
      return { ok: false, unsupported: true, error: `cleanup unsupported for ${record.handle?.kind ?? 'missing-handle'}` };
    }
    const sessionId = record.handle.id;
    if (!sessionId) {
      return { ok: false, unsupported: true, error: 'missing process session id' };
    }
    try {
      const shouldKill = reason !== 'completed';
      logger.warn('[tool-run-registry] cleaning process handle', {
        reason,
        shouldKill,
        sessionKey: record.sessionKey,
        runId: record.runId,
        toolCallId: record.toolCallId,
        toolName: record.toolName,
        sessionId,
        pid: record.handle.pid,
      });
      if (shouldKill) {
        await this.rpc('process', { action: 'kill', sessionId }, 8_000);
      }
      await this.rpc('process', { action: 'remove', sessionId }, 8_000).catch((error) => {
        logger.warn('[tool-run-registry] process remove failed after kill', {
          sessionId,
          error: String(error),
        });
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  }

  private emitToolRunTerminalEvent(record: ToolRunRecord): void {
    if (record.status === 'completed' || record.status === 'cancelled') {
      logger.info('[tool-run-registry] terminal tool event is silent', {
        status: record.status,
        terminalReason: record.terminalReason,
        sessionKey: record.sessionKey,
        runId: record.runId,
        toolCallId: record.toolCallId,
        toolName: record.toolName,
      });
      return;
    }
    const elapsedMs = Math.max(0, Date.now() - record.startedAt);
    const idleMs = record.lastProgressAt ? Math.max(0, Date.now() - record.lastProgressAt) : null;
    const failureText = this.buildInjectedToolFailureText(record, elapsedMs);
    const message = {
      role: 'toolResult',
      toolCallId: record.toolCallId,
      toolName: record.toolName,
      isError: true,
      content: [{
        type: 'text',
        text: failureText,
      }],
      details: {
        status: record.status,
        reason: record.terminalReason,
        elapsedMs,
        idleMs,
        cleanupAttempted: record.cleanup.attempted,
        cleanupSucceeded: record.cleanup.status === 'succeeded'
          ? true
          : record.cleanup.status === 'failed'
            ? false
            : null,
        cleanupStatus: record.cleanup.status,
        cleanupError: record.cleanup.error,
        retryable: record.cleanup.status === 'succeeded',
        suggestedNextActions: record.cleanup.status === 'succeeded'
          ? ['change-tool', 'change-parameters', 'retry', 'ask-user', 'explain-failure']
          : ['change-tool', 'ask-user', 'explain-failure'],
        handle: record.handle,
      },
      timestamp: Date.now(),
    };
    const event = {
      state: 'tool_timeout',
      runId: record.runId,
      sessionKey: record.sessionKey,
      message,
    };
    logger.warn('[tool-run-registry] emitting tool terminal event', event);
    this.emit('chat:message', { message: event });
    if (record.visible && record.sessionKey && record.sessionKey !== 'unknown') {
      if (!this.shouldSendToolFailureFeedback(record)) {
        logger.warn('[tool-run-registry] skipped tool failure feedback after repeat limit', {
          sessionKey: record.sessionKey,
          runId: record.runId,
          toolCallId: record.toolCallId,
          toolName: record.toolName,
          terminalReason: record.terminalReason,
        });
        return;
      }
      void this.sendToolFailureFeedbackToModel(record, failureText).catch((error) => {
        logger.warn('[tool-run-registry] failed to send tool failure feedback to model', {
          sessionKey: record.sessionKey,
          runId: record.runId,
          toolCallId: record.toolCallId,
          toolName: record.toolName,
          error: String(error),
        });
      });
    }
  }

  private shouldSendToolFailureFeedback(record: ToolRunRecord): boolean {
    const max = 2;
    const signature = [
      record.sessionKey,
      record.toolName,
      record.terminalReason ?? record.status,
      record.cleanup.status,
    ].join('::');
    const count = this.toolFailureFeedbackCounts.get(signature) ?? 0;
    if (count >= max) return false;
    this.toolFailureFeedbackCounts.set(signature, count + 1);
    return true;
  }

  private buildInjectedToolFailureText(record: ToolRunRecord, elapsedMs: number): string {
    const seconds = Math.round(elapsedMs / 1000);
    if (record.status === 'kill_failed') {
      return `The ${record.toolName} tool timed out after ${seconds}s and cleanup failed. The previous process handle is unsafe to reuse. Do not poll this handle again. Choose another approach, ask the user, or explain the failure.`;
    }
    return `The ${record.toolName} tool timed out after ${seconds}s. Cleanup status: ${record.cleanup.status}. Do not repeat the exact same tool call. Try a safer bounded command, use another tool, ask the user for confirmation, or explain the failure.`;
  }

  private async sendToolFailureFeedbackToModel(record: ToolRunRecord, failureText: string): Promise<void> {
    const idempotencyKey = `tool-failure-feedback:${record.toolRunId}:${record.terminalReason ?? record.status}`;
    const message = [
      '[LYCLAW internal tool failure feedback]',
      failureText,
      '',
      'This is internal control feedback from the runtime. Continue the user task if possible. Do not reveal this control message verbatim.',
    ].join('\n');
    logger.warn('[tool-run-registry] sending tool failure feedback to model', {
      sessionKey: record.sessionKey,
      runId: record.runId,
      toolCallId: record.toolCallId,
      toolName: record.toolName,
      cleanup: record.cleanup,
    });
    await this.rpc('chat.send', {
      sessionKey: record.sessionKey,
      message,
      deliver: false,
      idempotencyKey,
    }, 120_000);
  }

  private recordChatSendAccepted(args: {
    method: string;
    params?: unknown;
    result: unknown;
    requestedAt: number;
    acceptedAt: number;
    rpcDurationMs: number;
  }): void {
    if (args.method !== 'chat.send') {
      return;
    }

    const kind = this.isWarmupChatSend(args.method, args.params)
      ? 'warmup'
      : this.isInternalToolFeedbackChatSend(args.method, args.params)
        ? 'internal'
        : 'user';
    const sessionKey = this.getChatSendSessionKey(args.params);
    const runId = this.getRunIdFromRpcResult(args.result);
    if (!runId) {
      logger.info('[perf:chat-run] chat.send.accepted_without_run_id', {
        kind,
        sessionKey,
        rpcDurationMs: args.rpcDurationMs,
      });
      return;
    }

    if (kind === 'user' && this.status.state === 'running') {
      this.clearGatewayReadyFallback();
      if (!this.status.gatewayReady) {
        this.setStatus({ gatewayReady: true });
      }
      if (!this.isWarmedUp) {
        this.clearWarmupTimer();
      }
    }

    this.chatRunMetrics.set(runId, {
      kind,
      sessionKey,
      requestedAt: args.requestedAt,
      acceptedAt: args.acceptedAt,
      rpcDurationMs: args.rpcDurationMs,
      firstEventWatchdogTimers: this.scheduleChatRunFirstEventWatchdog(runId),
      firstVisibleProgressWatchdogTimers: this.scheduleChatRunFirstVisibleProgressWatchdog(runId),
    });
    logger.info('[perf:chat-run] chat.send.accepted', {
      kind,
      runId,
      sessionKey,
      rpcDurationMs: args.rpcDurationMs,
      timeToAcceptedMs: args.acceptedAt - args.requestedAt,
    });
  }

  private recordChatEventTiming(payload: unknown): void {
    if (!payload || typeof payload !== 'object') {
      return;
    }

    const event = payload as { state?: unknown; runId?: unknown; message?: unknown };
    const runId = typeof event.runId === 'string' ? event.runId : '';
    const state = typeof event.state === 'string' ? event.state : 'unknown';
    const eventSessionKey = typeof (payload as Record<string, unknown>).sessionKey === 'string'
      ? String((payload as Record<string, unknown>).sessionKey)
      : undefined;
    if (!runId) {
      logger.info('[perf:chat-run] event.without_run_id', {
        state,
        hasMessage: Boolean(event.message),
      });
      this.observeToolRunFromChatEvent(event, eventSessionKey);
      return;
    }

    const now = Date.now();
    const metrics = this.chatRunMetrics.get(runId);
    if (!metrics) {
      logger.info('[perf:chat-run] event.untracked', {
        runId,
        state,
        hasMessage: Boolean(event.message),
      });
      this.observeToolRunFromChatEvent(event, eventSessionKey);
      return;
    }

    this.observeToolRunFromChatEvent(event, metrics.sessionKey ?? eventSessionKey);

    if (!metrics.firstEventAt) {
      metrics.firstEventAt = now;
      if (metrics.firstEventWatchdogTimers) {
        for (const timer of metrics.firstEventWatchdogTimers) {
          clearTimeout(timer);
        }
        metrics.firstEventWatchdogTimers = undefined;
      }
      logger.info('[perf:chat-run] event.first', {
        kind: metrics.kind,
        runId,
        sessionKey: metrics.sessionKey,
        state,
        hasMessage: Boolean(event.message),
        sinceAcceptedMs: now - metrics.acceptedAt,
        sinceRequestedMs: now - metrics.requestedAt,
        rpcDurationMs: metrics.rpcDurationMs,
      });
      if (metrics.kind === 'user') {
        // recordChatStreamEvent({
        //   runId,
        //   state,
        //   sessionKey: metrics.sessionKey,
        // });
      }
    }

    if (state === 'delta' && !metrics.firstDeltaAt) {
      metrics.firstDeltaAt = now;
      logger.info('[perf:chat-run] delta.first', {
        kind: metrics.kind,
        runId,
        sessionKey: metrics.sessionKey,
        sinceAcceptedMs: now - metrics.acceptedAt,
        sinceRequestedMs: now - metrics.requestedAt,
        sinceFirstEventMs: metrics.firstEventAt ? now - metrics.firstEventAt : null,
        rpcDurationMs: metrics.rpcDurationMs,
      });
      if (metrics.kind === 'user' && !this.isWarmedUp) {
        this.isWarmedUp = true;
        this.hasWarmupFailed = false;
        this.setStatus({ warmupStatus: 'ready' });
        logger.info('[perf:first-session] gateway.warmup.completed_by_user_delta', {
          runId,
          sessionKey: metrics.sessionKey,
          timeToFirstDeltaMs: now - metrics.acceptedAt,
          rpcDurationMs: metrics.rpcDurationMs,
        });
      }
    }

    const visibleProgress = this.classifyVisibleProgress(event.message);
    if (visibleProgress.visible && !metrics.firstVisibleProgressAt) {
      metrics.firstVisibleProgressAt = now;
      metrics.firstVisibleProgressKind = visibleProgress.kind;
      if (metrics.firstVisibleProgressWatchdogTimers) {
        for (const timer of metrics.firstVisibleProgressWatchdogTimers) {
          clearTimeout(timer);
        }
        metrics.firstVisibleProgressWatchdogTimers = undefined;
      }
      logger.info('[perf:chat-run] visible_progress.first', {
        kind: metrics.kind,
        runId,
        sessionKey: metrics.sessionKey,
        state,
        visibleProgressKind: visibleProgress.kind,
        messageBlockTypes: visibleProgress.messageBlockTypes,
        sinceAcceptedMs: now - metrics.acceptedAt,
        sinceRequestedMs: now - metrics.requestedAt,
        sinceFirstEventMs: metrics.firstEventAt ? now - metrics.firstEventAt : null,
        sinceFirstDeltaMs: metrics.firstDeltaAt ? now - metrics.firstDeltaAt : null,
        rpcDurationMs: metrics.rpcDurationMs,
      });
      if (metrics.kind === 'user') {
        // recordChatStreamEvent({
        //   runId,
        //   state,
        //   sessionKey: metrics.sessionKey,
        //   visibleProgressKind: visibleProgress.kind,
        //   messageBlockTypes: visibleProgress.messageBlockTypes,
        // });
      }
      if (metrics.kind === 'user' && !this.isWarmedUp) {
        this.isWarmedUp = true;
        this.hasWarmupFailed = false;
        this.setStatus({ warmupStatus: 'ready' });
      }
    }

    if (state === 'delta' && metrics.kind === 'user') {
      // recordChatStreamEvent({
      //   runId,
      //   state,
      //   sessionKey: metrics.sessionKey,
      // });
    }

    if (state === 'final' || state === 'error' || state === 'aborted') {
      const shouldRecoverEmptyFinal = state === 'final' && metrics.kind === 'user' && !event.message;
      if (metrics.kind === 'warmup') {
        this.resolveWarmupCompletion(runId, state);
      }
      if (metrics.firstEventWatchdogTimers) {
        for (const timer of metrics.firstEventWatchdogTimers) {
          clearTimeout(timer);
        }
        metrics.firstEventWatchdogTimers = undefined;
      }
      if (metrics.firstVisibleProgressWatchdogTimers) {
        for (const timer of metrics.firstVisibleProgressWatchdogTimers) {
          clearTimeout(timer);
        }
        metrics.firstVisibleProgressWatchdogTimers = undefined;
      }
      logger.info('[perf:chat-run] run.completed', {
        kind: metrics.kind,
        runId,
        sessionKey: metrics.sessionKey,
        state,
        totalSinceRequestedMs: now - metrics.requestedAt,
        totalSinceAcceptedMs: now - metrics.acceptedAt,
        timeToFirstEventMs: metrics.firstEventAt ? metrics.firstEventAt - metrics.acceptedAt : null,
        timeToFirstDeltaMs: metrics.firstDeltaAt ? metrics.firstDeltaAt - metrics.acceptedAt : null,
        timeToFirstVisibleProgressMs: metrics.firstVisibleProgressAt ? metrics.firstVisibleProgressAt - metrics.acceptedAt : null,
        firstVisibleProgressKind: metrics.firstVisibleProgressKind,
        rpcDurationMs: metrics.rpcDurationMs,
      });
      const emptyFinalDiagnostic = shouldRecoverEmptyFinal
        ? {
          runId,
          sessionKey: metrics.sessionKey,
          totalSinceAcceptedMs: now - metrics.acceptedAt,
          totalSinceRequestedMs: now - metrics.requestedAt,
          timeToFirstEventMs: metrics.firstEventAt ? metrics.firstEventAt - metrics.acceptedAt : null,
          timeToFirstDeltaMs: metrics.firstDeltaAt ? metrics.firstDeltaAt - metrics.acceptedAt : null,
          timeToFirstVisibleProgressMs: metrics.firstVisibleProgressAt ? metrics.firstVisibleProgressAt - metrics.acceptedAt : null,
          firstVisibleProgressKind: metrics.firstVisibleProgressKind,
          rpcDurationMs: metrics.rpcDurationMs,
          trackedChatRunsBeforeCompletion: this.getTrackedChatRunSnapshot(now),
        }
        : null;
      this.chatRunMetrics.delete(runId);
      if (metrics.kind === 'user') {
        this.scheduleTerminalSessionLockAudit(metrics.sessionKey, runId, state);
      }
      if (emptyFinalDiagnostic) {
        void this.recordEmptyUserChatFinalDiagnostic(emptyFinalDiagnostic);
      }
    }
  }

  private scheduleTerminalSessionLockAudit(
    sessionKey: string | undefined,
    runId: string,
    state: string,
  ): void {
    const key = sessionKey?.trim();
    if (!key) return;

    const existing = this.terminalLockAuditTimersBySession.get(key);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.terminalLockAuditTimersBySession.delete(key);
      void this.auditTerminalSessionTranscriptLock(key, runId, state).catch((error) => {
        logger.warn('[gateway:session-lock-recovery] terminal lock audit failed', {
          sessionKey: key,
          runId,
          state,
          error: String(error),
        });
      });
    }, GatewayManager.TERMINAL_LOCK_AUDIT_DELAY_MS);
    this.terminalLockAuditTimersBySession.set(key, timer);
  }

  private async auditTerminalSessionTranscriptLock(
    sessionKey: string,
    runId: string,
    state: string,
  ): Promise<void> {
    const result = await this.recoverSessionTranscriptLock(
      sessionKey,
      `terminal-user-chat-${state}`,
    );
    if (!result) return;

    logger.info('[gateway:session-lock-recovery] terminal lock audit completed', {
      sessionKey,
      runId,
      state,
      recovered: result.recovered,
      reason: result.recovered ? 'recovered' : result.reason,
      lockPath: result.lockPath,
      lockAgeMs: result.lockAgeMs,
      details: !result.recovered ? result.details : undefined,
    });
  }

  private async prepareForUserChatSend(method: string, params?: unknown): Promise<void> {
    if (!this.isUserChatSend(method, params)) {
      return;
    }

    await this.supersedeTrackedUserRunsBeforeChatSend(params);
    await this.recoverStaleEmptyFinalBeforeChatSend(params);
    await this.recoverSessionTranscriptLockForChatSend(params, 'before-user-chat-send');

    if (this.warmupTimer) {
      this.clearWarmupTimer();
      logger.info('[perf:first-session] gateway.warmup.skipped', {
        reason: 'user_chat_before_warmup_started',
      });
      return;
    }

    if (!this.warmupRequestPromise) {
      return;
    }

    const waitStart = Date.now();
    const elapsedWarmupMs = this.warmupStartedAt ? waitStart - this.warmupStartedAt : null;
    const maxWaitMs = elapsedWarmupMs != null && elapsedWarmupMs >= GatewayManager.WARMUP_NEAR_COMPLETION_AFTER_MS
      ? GatewayManager.WARMUP_NEAR_COMPLETION_WAIT_MS
      : GatewayManager.WARMUP_BACKGROUND_RPC_RELEASE_MS;
    logger.info('[perf:first-session] gateway.warmup.waiting_before_user_chat', {
      reason: elapsedWarmupMs != null && elapsedWarmupMs >= GatewayManager.WARMUP_NEAR_COMPLETION_AFTER_MS
        ? 'near_completion_short_wait_before_user_chat'
        : 'background_release_wait_before_user_chat',
      elapsedWarmupMs,
      maxWaitMs,
    });
    let warmupSettled = false;
    await Promise.race([
      this.warmupRequestPromise.then(
        () => { warmupSettled = true; },
        () => { warmupSettled = true; },
      ),
      new Promise<void>((resolve) => setTimeout(resolve, maxWaitMs)),
    ]);
    if (warmupSettled) {
      logger.info('[perf:first-session] gateway.warmup.waited_before_user_chat', {
        waitedMs: Date.now() - waitStart,
        elapsedWarmupMs: this.warmupStartedAt ? Date.now() - this.warmupStartedAt : elapsedWarmupMs,
        maxWaitMs,
        warmupReady: this.isWarmedUp,
      });
      return;
    }
    logger.info('[perf:first-session] gateway.warmup.not_waiting_before_user_chat', {
      waitedMs: Date.now() - waitStart,
      elapsedWarmupMs: this.warmupStartedAt ? Date.now() - this.warmupStartedAt : elapsedWarmupMs,
      maxWaitMs,
      warmupReady: this.isWarmedUp,
    });
  }

  private async handleToolLifecycleRpcSideEffects(method: string, params?: unknown): Promise<void> {
    if (method !== 'sessions.abort') return;
    const sessionKey = this.getRpcSessionKey(method, params);
    const runId = params && typeof params === 'object' && typeof (params as { runId?: unknown }).runId === 'string'
      ? (params as { runId: string }).runId
      : null;
    try {
      const records = runId
        ? await this.toolRunRegistry.cancelByRun(runId, 'user-cancelled')
        : await this.toolRunRegistry.cancelBySession(sessionKey, 'user-cancelled');
      if (records.length > 0) {
        logger.warn('[tool-run-registry] cancelled active tools for sessions.abort', {
          sessionKey,
          runId,
          count: records.length,
          toolRunIds: records.map((record) => record.toolRunId),
        });
      }
    } catch (error) {
      logger.warn('[tool-run-registry] failed to cancel active tools for sessions.abort', {
        sessionKey,
        runId,
        error: String(error),
      });
    }
  }

  private async recoverStaleEmptyFinalBeforeChatSend(params: unknown): Promise<void> {
    const sessionKey = this.getChatSendSessionKey(params);
    if (!sessionKey) return;
    const diagnostic = this.getLatestEmptyFinalDiagnostic(sessionKey);
    if (!diagnostic) return;

    const result = await this.recoverStaleSessionAfterEmptyFinal(sessionKey);
    logger.info('[gateway:session-stale-recovery] checked before new user message', {
      sessionKey,
      previousRunId: diagnostic.runId,
      recovered: result.ok ? result.recovered : false,
      reason: result.ok ? result.reason : result.error,
    });
  }

  private async supersedeTrackedUserRunsBeforeChatSend(params: unknown): Promise<void> {
    const sessionKey = this.getChatSendSessionKey(params);
    const trackedRuns = this.getTrackedUserRunsForSession(sessionKey);
    if (!sessionKey || trackedRuns.length === 0) return;

    const reason = 'superseded-by-new-user-message';
    logger.warn('[gateway:chat-run] superseding tracked user runs before new message', {
      reason,
      sessionKey,
      runs: trackedRuns.map(([runId, run]) => ({
        runId,
        ageSinceAcceptedMs: Date.now() - run.acceptedAt,
        hasFirstDelta: Boolean(run.firstDeltaAt),
        hasFirstVisibleProgress: Boolean(run.firstVisibleProgressAt),
      })),
    });

    for (const [runId, run] of trackedRuns) {
      try {
        await this.rpc('sessions.abort', { key: sessionKey, runId }, 8_000);
      } catch (error) {
        logger.warn('[gateway:chat-run] failed to abort superseded run before new message', {
          reason,
          sessionKey,
          runId,
          error: String(error),
        });
      }
      this.settleTrackedUserRunLocally(runId, run, reason);
    }

    await this.recoverSessionTranscriptLock(sessionKey, reason, {
      allowCurrentGatewayActiveLockRecovery: true,
    });
  }

  private async recoverSessionTranscriptLockForChatSend(params: unknown, reason: string): Promise<void> {
    const sessionKey = this.getChatSendSessionKey(params);
    await this.recoverSessionTranscriptLock(sessionKey, reason);
  }

  private async recoverSessionTranscriptLock(
    sessionKey: string | undefined,
    reason: string,
    options: { allowCurrentGatewayActiveLockRecovery?: boolean } = {},
  ): Promise<SessionTranscriptLockRecoveryResult | undefined> {
    if (!sessionKey) return undefined;
    const hasTrackedActiveRun = [...this.chatRunMetrics.values()].some(
      (run) => run.kind === 'user' && run.sessionKey === sessionKey,
    );
    if (hasTrackedActiveRun) {
      logger.info('[gateway:session-lock-recovery] skipped', {
        reason,
        sessionKey,
        skipReason: 'tracked-active-run',
      });
      return { recovered: false, reason: 'tracked-active-run' };
    }
    try {
      const result = await recoverOrphanedSessionTranscriptLock({
        sessionKey,
        openclawDir: path.join(homedir(), '.openclaw'),
        currentPid: this.process?.pid ?? this.status.pid ?? process.pid,
        reason,
        logger,
        allowCurrentGatewayActiveLockRecovery: options.allowCurrentGatewayActiveLockRecovery,
      });
      if (!result.recovered && result.reason !== 'lock-missing') {
        logger.info('[gateway:session-lock-recovery] skipped', {
          reason,
          sessionKey,
          skipReason: result.reason,
          lockPath: result.lockPath,
          lockAgeMs: result.lockAgeMs,
          details: result.details,
        });
      }
      return result;
    } catch (error) {
      logger.warn('[gateway:session-lock-recovery] failed', {
        reason,
        sessionKey,
        error: String(error),
      });
      return { recovered: false, reason: 'recovery-failed' };
    }
  }

  /**
   * Check if Gateway has completed warmup
   */
  getIsWarmedUp(): boolean {
    return this.isWarmedUp;
  }

  /**
   * Make an RPC call to the Gateway
   * Uses OpenClaw protocol format: { type: "req", id: "...", method: "...", params: {...} }
   */
  async rpc<T>(method: string, params?: unknown, timeoutMs = 30000): Promise<T> {
    const effectiveParams = method === 'chat.send'
      ? await enrichChatSendParams(params)
      : params;
    await this.warnIfDigitalEmployeeIsolationMissing(method, effectiveParams);
    await this.prepareForUserChatSend(method, effectiveParams);
    const rpcStart = Date.now();
    logger.info(`[rpc] ${method} started (timeout=${timeoutMs}ms)`);

    let requestId: string | null = null;
    let chatSendWatchdogTimers: NodeJS.Timeout[] = [];
    return await new Promise<T>((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        logger.warn(`[rpc] ${method} failed: Gateway not connected`);
        reject(new Error('Gateway not connected'));
        return;
      }

      const id = crypto.randomUUID();
      requestId = id;
      // void beginChatSendTrace({
      //   requestId: id,
      //   method,
      //   params,
      //   timeoutMs,
      // });
      this.rpcInflight.set(id, {
        method,
        startedAt: rpcStart,
        timeoutMs,
        sessionKey: this.getRpcSessionKey(method, effectiveParams),
      });
      chatSendWatchdogTimers = this.scheduleChatSendWatchdog({
        requestId: id,
        method,
        params: effectiveParams,
        rpcStart,
      });

      // Set timeout for request
      const timeout = setTimeout(() => {
        logger.warn(`[rpc] ${method} timeout after ${Date.now() - rpcStart}ms`);
        rejectPendingGatewayRequest(this.pendingRequests, id, new Error(`RPC timeout: ${method}`));
      }, timeoutMs);

      // Store pending request
      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      });

      // Send request using OpenClaw protocol format
      const request = {
        type: 'req',
        id,
        method,
        params: effectiveParams,
      };

      try {
        this.ws.send(JSON.stringify(request));
        logger.info(`[rpc] ${method} sent to Gateway`);
      } catch (error) {
        logger.warn(`[rpc] ${method} send failed: ${String(error)}`);
        rejectPendingGatewayRequest(this.pendingRequests, id, new Error(`Failed to send RPC request: ${error}`));
      }
    }).then((result) => {
      const duration = Date.now() - rpcStart;
      logger.info(`[rpc] ${method} completed in ${duration}ms`);
      if (requestId) {
        // finishChatSendRpc({
        //   requestId,
        //   success: true,
        //   runId: this.getRunIdFromRpcResult(result) ?? undefined,
        //   durationMs: duration,
        // });
      }
      this.recordChatSendAccepted({
        method,
        params: effectiveParams,
        result,
        requestedAt: rpcStart,
        acceptedAt: Date.now(),
        rpcDurationMs: duration,
      });
      this.recordRpcSuccess();
      // Memory Doctor 返回值可能包含长期记忆正文。所�?Main 可控�?RPC
      // 出口统一二次净化，避免�?Memory �?Runtime 侧写入绕过最新规则�?
      return protectMemoryRpcOutput(method, result);
    }).catch((error) => {
      const duration = Date.now() - rpcStart;
      logger.warn(`[rpc] ${method} failed after ${duration}ms: ${String(error)}`);
      if (requestId) {
        // finishChatSendRpc({
        //   requestId,
        //   success: false,
        //   durationMs: duration,
        //   error: String(error),
        // });
      }
      if (isTransportRpcFailure(error)) {
        this.recordRpcFailure(method);
      }
      throw error;
    }).finally(() => {
      for (const timer of chatSendWatchdogTimers) {
        clearTimeout(timer);
      }
      if (requestId) {
        this.rpcInflight.delete(requestId);
      }
    });
  }

  /**
   * Start health check monitoring
   */
  private startHealthCheck(): void {
    this.connectionMonitor.startHealthCheck({
      shouldCheck: () => this.status.state === 'running',
      checkHealth: () => this.checkHealth(),
      onUnhealthy: (errorMessage) => {
        this.emit('error', new Error(errorMessage));
      },
      onError: () => {
        // The monitor already logged the error; nothing else to do here.
      },
    });
  }

  /**
   * Check Gateway health via WebSocket ping
   * OpenClaw Gateway doesn't have an HTTP /health endpoint
   */
  async checkHealth(): Promise<{ ok: boolean; error?: string; uptime?: number }> {
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        const uptime = this.status.connectedAt
          ? Math.floor((Date.now() - this.status.connectedAt) / 1000)
          : undefined;
        return { ok: true, uptime };
      }
      return { ok: false, error: 'WebSocket not connected' };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  }

  private recordGatewayAlive(): void {
    this.diagnostics.lastAliveAt = Date.now();
    this.diagnostics.consecutiveHeartbeatMisses = 0;
  }

  private recordRpcSuccess(): void {
    this.diagnostics.lastRpcSuccessAt = Date.now();
    this.diagnostics.consecutiveRpcFailures = 0;
  }

  private recordRpcFailure(method: string): void {
    this.diagnostics.lastRpcFailureAt = Date.now();
    this.diagnostics.lastRpcFailureMethod = method;
    this.diagnostics.consecutiveRpcFailures += 1;
  }

  private recordHeartbeatTimeout(consecutiveMisses: number): void {
    this.diagnostics.lastHeartbeatTimeoutAt = Date.now();
    this.diagnostics.consecutiveHeartbeatMisses = consecutiveMisses;
  }

  private recordSocketClose(code: number): void {
    this.diagnostics.lastSocketCloseAt = Date.now();
    this.diagnostics.lastSocketCloseCode = code;
  }

  /**
   * Start Gateway process
   * Uses OpenClaw npm package from node_modules (dev) or resources (production)
   */
  private async startProcess(): Promise<void> {
    const launchContext = await prepareGatewayLaunchContext(this.status.port);
    await unloadLaunchctlGatewayService();
    this.processExitCode = null;

    // Per-process dedup map for stderr lines �?resets on each new spawn.
    const stderrDedup = new Map<string, number>();

    const { child, lastSpawnSummary } = await launchGatewayProcess({
      port: this.status.port,
      launchContext,
      sanitizeSpawnArgs: (args) => this.sanitizeSpawnArgs(args),
      getCurrentState: () => this.status.state,
      getShouldReconnect: () => this.shouldReconnect,
      onStderrLine: (line) => {
        recordGatewayStartupStderrLine(this.recentStartupStderrLines, line);
        const classified = classifyGatewayStderrMessage(line);
        this.recordSessionWriteLockLog(classified.normalized);
        this.recordStuckSessionDiagnostic(classified.normalized);
        if (classified.level === 'drop') return;

        // Dedup: suppress identical stderr lines after the first occurrence.
        const count = (stderrDedup.get(classified.normalized) ?? 0) + 1;
        stderrDedup.set(classified.normalized, count);
        if (count > 1) {
          // Log a summary every 50 duplicates to stay visible without flooding.
          if (count % 50 === 0) {
            logger.debug(`[Gateway stderr] (suppressed ${count} repeats) ${classified.normalized}`);
          }
          return;
        }

        if (classified.level === 'debug') {
          logger.debug(`[Gateway stderr] ${classified.normalized}`);
          return;
        }
        logger.warn(`[Gateway stderr] ${classified.normalized}`);
      },
      onStdoutLine: (line) => {
        const normalized = line.replace(/\r$/, '').trimEnd();
        if (!normalized.trim()) return;
        logger.debug(`[Gateway stdout] ${normalized.trim()}`);
        this.parseGatewayDebugStdoutLine(normalized);
        if (isInvalidConfigSignal(normalized)) {
          recordGatewayStartupStderrLine(this.recentStartupStderrLines, normalized);
        }
      },
      onSpawn: (pid) => {
        this.setStatus({ pid });
      },
      onExit: (exitedChild, code) => {
        this.processExitCode = code;
        this.ownsProcess = false;
        this.connectionMonitor.clear();
        if (this.process === exitedChild) {
          this.process = null;
        }
        this.emit('exit', code);

        if (this.status.state === 'running') {
          this.setStatus({ state: 'stopped' });
        }

        // Always attempt reconnect from process exit.  scheduleReconnect()
        // internally checks shouldReconnect and reconnect-timer guards, so
        // calling it unconditionally is safe �?intentional stop() calls set
        // shouldReconnect=false which makes scheduleReconnect() no-op.
        //
        // On Windows, the WS close handler intentionally skips reconnect
        // (to avoid racing with this exit handler).  However, WS close
        // fires *before* process exit and sets state='stopped', which
        // previously caused this handler to also skip reconnect �?leaving
        // the gateway permanently dead with no recovery path.
        this.scheduleReconnect();
      },
      onError: () => {
        this.ownsProcess = false;
        if (this.process === child) {
          this.process = null;
        }
      },
    });

    this.process = child;
    this.ownsProcess = true;
    logger.debug(`Gateway manager now owns process pid=${child.pid ?? 'unknown'}`);
    this.lastSpawnSummary = lastSpawnSummary;
  }

  /**
   * Connect WebSocket to Gateway
   */
  private async connect(port: number, _externalToken?: string): Promise<void> {
    this.ws = await connectGatewaySocket({
      port,
      deviceIdentity: this.deviceIdentity,
      platform: process.platform,
      pendingRequests: this.pendingRequests,
      getToken: async () => await import('../utils/store').then(({ getSetting }) => getSetting('gatewayToken')),
      onHandshakeComplete: (ws) => {
        this.ws = ws;
        ws.on('pong', () => {
          this.connectionMonitor.markAlive('pong');
          this.recordGatewayAlive();
        });
        this.recordGatewayAlive();
        this.setStatus({
          state: 'running',
          port,
          connectedAt: Date.now(),
        });
        this.startPing();
        this.scheduleGatewayReadyFallback();
      },
      onMessage: (message) => {
        this.handleMessage(message);
      },
      onCloseAfterHandshake: (closeCode) => {
        this.connectionMonitor.clear();
        this.recordSocketClose(closeCode);
        this.diagnostics.consecutiveHeartbeatMisses = 0;
        if (this.status.state === 'running') {
          this.setStatus({ state: 'stopped' });
          // On Windows, skip reconnect from WS close.  The Gateway is a local
          // child process; actual crashes are already caught by the process exit
          // handler (`onExit`) which calls scheduleReconnect().  Triggering
          // reconnect from WS close as well races with the exit handler and can
          // cause double start() attempts or port conflicts during TCP TIME_WAIT.
          //
          // Exception: code=1012 means the Gateway is performing an in-process
          // restart (e.g. config reload).  The UtilityProcess stays alive, so
          // `onExit` will never fire �?we MUST reconnect from the WS close path.
          if (process.platform !== 'win32' || closeCode === 1012) {
            this.scheduleReconnect();
          }
        }
      },
    });
  }

  /**
   * Handle incoming WebSocket message
   */
  private handleMessage(message: unknown): void {
    this.connectionMonitor.markAlive('message');
    this.recordGatewayAlive();

    if (typeof message !== 'object' || message === null) {
      logger.debug('Received non-object Gateway message');
      return;
    }

    const msg = message as Record<string, unknown>;

    // Handle OpenClaw protocol response format: { type: "res", id: "...", ok: true/false, ... }
    if (msg.type === 'res' && typeof msg.id === 'string') {
      if (msg.ok === false || msg.error) {
        const errorObj = msg.error as { message?: string; code?: number } | undefined;
        const errorMsg = errorObj?.message || JSON.stringify(msg.error) || 'Unknown error';
        if (rejectPendingGatewayRequest(this.pendingRequests, msg.id, new Error(errorMsg))) {
          return;
        }
      } else if (resolvePendingGatewayRequest(this.pendingRequests, msg.id, msg.payload ?? msg)) {
        return;
      }
    }

    // Handle OpenClaw protocol event format: { type: "event", event: "...", payload: {...} }
    if (msg.type === 'event' && typeof msg.event === 'string') {
      if (msg.event === 'chat') {
        this.recordChatEventTiming(msg.payload);
      }
      if (msg.event === 'exec.approval.requested') {
        void handleGatewayExecApprovalRequested(msg.payload, {
          request: this.rpc.bind(this),
        }).catch((error) => {
          logger.warn(`[security:gateway-exec] Approval bridge failed: ${String(error)}`);
        });
      }
      dispatchProtocolEvent(this, msg.event, msg.payload);
      return;
    }

    // Fallback: Check if this is a JSON-RPC 2.0 response (legacy support)
    if (isResponse(message) && message.id && this.pendingRequests.has(String(message.id))) {
      if (message.error) {
        const errorMsg = typeof message.error === 'object'
          ? (message.error as { message?: string }).message || JSON.stringify(message.error)
          : String(message.error);
        rejectPendingGatewayRequest(this.pendingRequests, String(message.id), new Error(errorMsg));
      } else {
        resolvePendingGatewayRequest(this.pendingRequests, String(message.id), message.result);
      }
      return;
    }

    // Check if this is a JSON-RPC notification (server-initiated event)
    if (isNotification(message)) {
      dispatchJsonRpcNotification(this, message);
      return;
    }

    this.emit('message', message);
  }

  /**
   * Start ping interval to keep connection alive
   */
  private startPing(): void {
    const isWindows = process.platform === 'win32';
    this.connectionMonitor.startPing({
      intervalMs: isWindows
        ? GatewayManager.HEARTBEAT_INTERVAL_MS_WIN
        : GatewayManager.HEARTBEAT_INTERVAL_MS,
      timeoutMs: isWindows
        ? GatewayManager.HEARTBEAT_TIMEOUT_MS_WIN
        : GatewayManager.HEARTBEAT_TIMEOUT_MS,
      maxConsecutiveMisses: isWindows
        ? GatewayManager.HEARTBEAT_MAX_MISSES_WIN
        : GatewayManager.HEARTBEAT_MAX_MISSES,
      sendPing: () => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.ping();
        }
      },
      onHeartbeatTimeout: ({ consecutiveMisses, timeoutMs }) => {
        this.recordHeartbeatTimeout(consecutiveMisses);
        const pid = this.process?.pid ?? 'unknown';
        const isWindows = process.platform === 'win32';
        const shouldAttemptRecovery = !isWindows && this.shouldReconnect && this.status.state === 'running';
        logger.warn(
          `Gateway heartbeat: ${consecutiveMisses} consecutive pong misses ` +
            `(timeout=${timeoutMs}ms, pid=${pid}, state=${this.status.state}, autoReconnect=${this.shouldReconnect}).`,
        );
        if (!shouldAttemptRecovery) {
          const reason = isWindows
            ? 'platform=win32'
            : 'lifecycle is not in auto-recoverable running state';
          logger.warn(`Gateway heartbeat recovery skipped (${reason})`);
          return;
        }
        logger.warn('Gateway heartbeat recovery: restarting unresponsive gateway process');
        void this.restart().catch((error) => {
          logger.warn('Gateway heartbeat recovery failed:', error);
        });
      },
    });
  }

  /**
   * Schedule reconnection attempt with exponential backoff
   */
  private scheduleReconnect(): void {
    const decision = getReconnectScheduleDecision({
      shouldReconnect: this.shouldReconnect,
      hasReconnectTimer: this.reconnectTimer !== null,
      reconnectAttempts: this.reconnectAttempts,
      maxAttempts: this.reconnectConfig.maxAttempts,
      baseDelay: this.reconnectConfig.baseDelay,
      maxDelay: this.reconnectConfig.maxDelay,
    });

    if (decision.action === 'skip') {
      logger.debug(`Gateway reconnect skipped (${decision.reason})`);
      return;
    }

    if (decision.action === 'already-scheduled') {
      return;
    }

    if (decision.action === 'fail') {
      logger.error(`Gateway reconnect failed: max attempts reached (${decision.maxAttempts})`);
      this.setStatus({
        state: 'error',
        error: 'Failed to reconnect after maximum attempts',
        reconnectAttempts: this.reconnectAttempts
      });
      return;
    }

    const cooldownRemaining = Math.max(0, GatewayManager.RESTART_COOLDOWN_MS - (Date.now() - this.lastRestartAt));
    const { delay, nextAttempt, maxAttempts } = decision;
    const effectiveDelay = Math.max(delay, cooldownRemaining);
    this.reconnectAttempts = nextAttempt;
    logger.warn(`Scheduling Gateway reconnect attempt ${nextAttempt}/${maxAttempts} in ${effectiveDelay}ms`);

    this.setStatus({
      state: 'reconnecting',
      reconnectAttempts: this.reconnectAttempts
    });
    const scheduledEpoch = this.lifecycleController.getCurrentEpoch();

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      const skipReason = getReconnectSkipReason({
        scheduledEpoch,
        currentEpoch: this.lifecycleController.getCurrentEpoch(),
        shouldReconnect: this.shouldReconnect,
      });
      if (skipReason) {
        logger.debug(`Skipping reconnect attempt: ${skipReason}`);
        return;
      }
      const attemptNo = this.reconnectAttempts;
      this.reconnectAttemptsTotal += 1;
      try {
        // Use the guarded start() flow so reconnect attempts cannot bypass
        // lifecycle locking and accidentally start duplicate Gateway processes.
        this.isAutoReconnectStart = true;
        await this.start();
        this.reconnectSuccessTotal += 1;
        this.emitReconnectMetric('success', {
          attemptNo,
          maxAttempts,
          delayMs: effectiveDelay,
        });
        this.reconnectAttempts = 0;
      } catch (error) {
        logger.error('Gateway reconnection attempt failed:', error);
        this.emitReconnectMetric('failure', {
          attemptNo,
          maxAttempts,
          delayMs: effectiveDelay,
          error: error instanceof Error ? error.message : String(error),
        });
        this.scheduleReconnect();
      }
    }, effectiveDelay);
  }

  private emitReconnectMetric(
    outcome: 'success' | 'failure',
    payload: {
      attemptNo: number;
      maxAttempts: number;
      delayMs: number;
      error?: string;
    },
  ): void {
    const successRate = this.reconnectAttemptsTotal > 0
      ? this.reconnectSuccessTotal / this.reconnectAttemptsTotal
      : 0;

    const properties = {
      outcome,
      attemptNo: payload.attemptNo,
      maxAttempts: payload.maxAttempts,
      delayMs: payload.delayMs,
      gateway_reconnect_success_count: this.reconnectSuccessTotal,
      gateway_reconnect_attempt_count: this.reconnectAttemptsTotal,
      gateway_reconnect_success_rate: Number(successRate.toFixed(4)),
      ...(payload.error ? { error: payload.error } : {}),
    };

    trackMetric('gateway.reconnect', properties);
    // Keep local metrics only; do not upload reconnect details to PostHog.
  }

  /**
   * Update status and emit event
   */
  private setStatus(update: Partial<GatewayStatus>): void {
    this.stateController.setStatus(update);
  }
}
