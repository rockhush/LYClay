import { hostApiFetch } from '@/lib/host-api';
import { estimateHistoryTokens } from '@/lib/token-estimator';
import { useGatewayStore } from '@/stores/gateway';
import { invokeSessionCompact } from './context-compactor';
import { resolveContextWindowForSession } from './context-send-guard';
import { resolveContextBudget } from './context-budget';
import type { ChatGet, ChatSet } from './store-api';
import type { ContextCompressionStatus } from './types';

const inFlight = new Set<string>();
const lastCheckAt = new Map<string, number>();
const CHECK_INTERVAL_MS = 2000;
const COOLDOWN_MS = 30000;
const lastCompactAt = new Map<string, number>();

function buildStatus(
  status: ContextCompressionStatus['status'],
  sessionKey: string,
  patch: Partial<ContextCompressionStatus> = {},
): ContextCompressionStatus {
  return { status, phase: 'runtime', sessionKey, ...patch };
}

export interface RuntimeContextCompressionOptions {
  runId?: string;
  requireActiveRun?: boolean;
  throttle?: boolean;
}

function normalizeOptions(optionsOrRunId?: string | RuntimeContextCompressionOptions): RuntimeContextCompressionOptions {
  if (typeof optionsOrRunId === 'string') {
    return { runId: optionsOrRunId, requireActiveRun: true, throttle: true };
  }
  return { requireActiveRun: true, throttle: true, ...optionsOrRunId };
}

async function fetchGatewayTokenCount(sessionKey: string): Promise<number> {
  try {
    const res = await hostApiFetch<{ totalTokens?: number; jsonlTokens?: number }>(
      `/api/sessions/token-usage?sessionKey=${encodeURIComponent(sessionKey)}`,
    );
    if (typeof res?.totalTokens === 'number' && res.totalTokens > 0) return Math.ceil(res.totalTokens);
    if (typeof res?.jsonlTokens === 'number' && res.jsonlTokens > 0) return res.jsonlTokens;
    return 0;
  } catch {
    return 0;
  }
}

export function maybeCompressRuntimeContext(
  set: ChatSet,
  get: ChatGet,
  optionsOrRunId?: string | RuntimeContextCompressionOptions,
): void {
  const options = normalizeOptions(optionsOrRunId);
  const state = get();
  const sessionKey = state.currentSessionKey;

  if (options.requireActiveRun && (!state.sending || state.activeRunId !== options.runId)) return;
  if (inFlight.has(sessionKey)) return;
  if (state.messages.length === 0) return;

  if (options.throttle) {
    const now = Date.now();
    const prev = lastCheckAt.get(sessionKey) ?? 0;
    if (now - prev < CHECK_INTERVAL_MS) return;
    lastCheckAt.set(sessionKey, now);
  }

  const now = Date.now();
  const prevCompact = lastCompactAt.get(sessionKey) ?? 0;
  if (now - prevCompact < COOLDOWN_MS) return;

  inFlight.add(sessionKey);

  void (async () => {
    try {
      const contextWindow = await resolveContextWindowForSession(sessionKey);
      const budget = resolveContextBudget(contextWindow);
      const latest = get();
      if (latest.currentSessionKey !== sessionKey) return;
      if (options.requireActiveRun && (!latest.sending || latest.activeRunId !== options.runId)) return;
      if (latest.messages.length === 0) return;

      const gatewayTokens = await fetchGatewayTokenCount(sessionKey);
      const rendererEstimate = estimateHistoryTokens(latest.messages);
      const estimatedTokens = gatewayTokens > 0 ? gatewayTokens : rendererEstimate;

      console.log('[context-compress] runtime check', {
        sessionKey,
        gatewayTokens,
        rendererEstimate,
        estimatedTokens,
        triggerTokens: budget.compressionTriggerTokens,
        requireActiveRun: options.requireActiveRun,
        sending: latest.sending,
      });

      if (estimatedTokens < budget.compressionTriggerTokens) return;

      // During an active run, sessions.compact would interrupt the agent.
      // Just log and skip — compaction happens at send time (send-guard) or
      // when idle (requireActiveRun: false in final-event handler).
      if (options.requireActiveRun && latest.sending) {
        console.log('[context-compress] runtime: context high, skipping (active run)');
        return;
      }

      // Idle (requireActiveRun: false) — safe to compact
      lastCompactAt.set(sessionKey, Date.now());

      set({ contextCompressionStatus: buildStatus('compressing', sessionKey, { startedAt: Date.now() }) });

      const gwResult = await invokeSessionCompact(
        sessionKey,
        (method, params, timeoutMs) => useGatewayStore.getState().rpc(method, params as Record<string, unknown>, timeoutMs),
      );

      console.log('[context-compress] runtime sessions.compact result:', {
        sessionKey,
        compacted: gwResult.compacted,
        reason: gwResult.reason,
        tokensAfter: gwResult.tokensAfter,
      });

      if (gwResult.compacted) {
        set({ contextCompressionStatus: buildStatus('compressed', sessionKey, { finishedAt: Date.now() }) });
        setTimeout(() => {
          const s = get();
          if (s.contextCompressionStatus?.status === 'compressed') {
            set({ contextCompressionStatus: null });
          }
        }, 5000);
        void latest.loadHistory(true);
      } else {
        set({ contextCompressionStatus: null });
      }
    } catch (error) {
      set({ contextCompressionStatus: buildStatus('failed', sessionKey, { finishedAt: Date.now(), message: error instanceof Error ? error.message : String(error) }) });
      setTimeout(() => {
        const s = get();
        if (s.contextCompressionStatus?.status === 'failed') {
          set({ contextCompressionStatus: null });
        }
      }, 5000);
    } finally {
      inFlight.delete(sessionKey);
    }
  })();
}
