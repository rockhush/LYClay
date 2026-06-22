import i18n from '@/i18n';
import { hostApiFetch } from '@/lib/host-api';
import { estimateHistoryTokens, estimateMessageTokens } from '@/lib/token-estimator';
import { useAgentsStore } from '@/stores/agents';
import { invokeSessionCompact, type InvokeRpcFn } from './context-compactor';
import { DEFAULT_CONTEXT_WINDOW, resolveContextBudget, type ContextBudget } from './context-budget';
import type { CompressionStateEntry, ContextCompressionStatus, RawMessage } from './types';

export type ContextSendGuardError = 'contextTooLarge' | 'currentMessageTooLarge';

export interface ContextSendGuardResult {
  messages: RawMessage[];
  compressed: boolean;
  budget: ContextBudget;
  error?: ContextSendGuardError;
  errorMessage?: string;
  compressionMeta?: CompressionStateEntry;
  gatewayCompacted?: boolean;
}

export interface PrepareContextBeforeSendInput {
  sessionKey: string;
  messages: RawMessage[];
  pendingUserMessage: RawMessage;
  runtimeMessage: string;
  workspaceContext?: string;
  isInternalStagedExecution: boolean;
  invokeCompactorRpc: InvokeRpcFn;
  persistedCompressionState?: CompressionStateEntry | null;
  onCompressionStatus?: (status: ContextCompressionStatus | null) => void;
}

const COMPACTION_COOLDOWN_MS = 30000;
const lastCompactionAttemptAt = new Map<string, number>();

interface ModelContextResponse {
  modelRef?: string | null;
  contextWindow?: number | null;
}

const modelContextWindowCache = new Map<string, number | null>();

function getAgentIdFromSessionKey(sessionKey: string): string {
  if (!sessionKey.startsWith('agent:')) return 'main';
  const [, agentId] = sessionKey.split(':');
  return agentId || 'main';
}

function getModelRefForSession(sessionKey: string): string | null {
  const agentId = getAgentIdFromSessionKey(sessionKey);
  const state = useAgentsStore.getState();
  const agent = state.agents.find((entry) => entry.id === agentId);
  return agent?.modelRef ?? state.defaultModelRef ?? null;
}

export async function resolveContextWindowForSession(sessionKey: string): Promise<number> {
  const modelRef = getModelRefForSession(sessionKey);
  if (!modelRef) return DEFAULT_CONTEXT_WINDOW;
  if (modelContextWindowCache.has(modelRef)) {
    return modelContextWindowCache.get(modelRef) ?? DEFAULT_CONTEXT_WINDOW;
  }

  try {
    const response = await hostApiFetch<ModelContextResponse>(`/api/model-context?modelRef=${encodeURIComponent(modelRef)}`);
    const contextWindow = response.contextWindow ?? null;
    modelContextWindowCache.set(modelRef, contextWindow);
    return contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  } catch (error) {
    console.warn('[context-send-guard] failed to resolve model context window, using fallback', {
      modelRef,
      error,
    });
    modelContextWindowCache.set(modelRef, null);
    return DEFAULT_CONTEXT_WINDOW;
  }
}

function buildPendingRuntimeMessage(input: PrepareContextBeforeSendInput): RawMessage {
  return {
    ...input.pendingUserMessage,
    content: `${input.runtimeMessage}${input.workspaceContext ?? ''}`,
  };
}

function getContextTooLargeMessage(): string {
  return i18n.t('chat:errors.contextTooLarge', {
    defaultValue: '当前会话上下文过大，自动压缩后仍超过当前模型限制。请开启更强压缩、切换更大上下文模型，或新建会话继续。',
  });
}

function getCurrentMessageTooLargeMessage(): string {
  return i18n.t('chat:errors.currentMessageTooLarge', {
    defaultValue: '本次输入过长，已超过当前模型可安全处理的上下文预算。请拆分输入，或改用文件/附件方式提供内容。',
  });
}

function buildResult(
  messages: RawMessage[],
  budget: ContextBudget,
  compressed: boolean,
  error?: ContextSendGuardError,
  gatewayCompacted = false,
): ContextSendGuardResult {
  return {
    messages,
    budget,
    compressed,
    gatewayCompacted,
    error,
    errorMessage: error === 'currentMessageTooLarge'
      ? getCurrentMessageTooLargeMessage()
      : error === 'contextTooLarge'
        ? getContextTooLargeMessage()
        : undefined,
  };
}

/**
 * Read Gateway's authoritative token count for a session.
 * Priority: 1) totalTokens from sessions.json (post-model-call),
 *           2) jsonlTokens estimated from JSONL file size (real-time).
 */
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

export async function prepareContextBeforeSend(input: PrepareContextBeforeSendInput): Promise<ContextSendGuardResult> {
  const contextWindow = await resolveContextWindowForSession(input.sessionKey);
  const budget = resolveContextBudget(contextWindow);

  if (input.isInternalStagedExecution || input.sessionKey === '__compactor__') {
    return buildResult(input.messages, budget, false);
  }

  const pendingRuntimeMessage = buildPendingRuntimeMessage(input);
  const pendingMessageTokens = estimateMessageTokens(pendingRuntimeMessage.content);

  if (pendingMessageTokens > Math.floor(budget.hardLimitTokens * 0.9)) {
    return buildResult(input.messages, budget, false, 'currentMessageTooLarge');
  }

  // Use Gateway's authoritative totalTokens from sessions.json.
  // Falls back to renderer estimate when Gateway hasn't written usage yet.
  const gatewayTokens = await fetchGatewayTokenCount(input.sessionKey);
  const rendererEstimate = estimateHistoryTokens([...input.messages, pendingRuntimeMessage]);
  let estimatedTokens = gatewayTokens > 0 ? gatewayTokens : rendererEstimate;

  console.log('[context-compress] send-guard check', {
    sessionKey: input.sessionKey,
    gatewayTokens,
    rendererEstimate,
    estimatedTokens,
    triggerTokens: budget.compressionTriggerTokens,
    hardLimitTokens: budget.hardLimitTokens,
  });

  let compressed = false;
  let gatewayCompacted = false;
  let compressionMeta: CompressionStateEntry | undefined;

  if (estimatedTokens >= budget.compressionTriggerTokens) {
    // Cooldown guard
    const now = Date.now();
    const lastAttempt = lastCompactionAttemptAt.get(input.sessionKey) ?? 0;
    if (now - lastAttempt < COMPACTION_COOLDOWN_MS) {
      console.log('[context-compress] send-guard skipped (cooldown)', {
        sessionKey: input.sessionKey,
        msSinceLast: now - lastAttempt,
      });
    } else {
      lastCompactionAttemptAt.set(input.sessionKey, now);

      input.onCompressionStatus?.({
        status: 'compressing',
        phase: 'before-send',
        sessionKey: input.sessionKey,
        startedAt: now,
        estimatedTokens,
        triggerTokens: budget.compressionTriggerTokens,
        hardLimitTokens: budget.hardLimitTokens,
      });

      try {
        const gwResult = await invokeSessionCompact(input.sessionKey, input.invokeCompactorRpc);
        gatewayCompacted = gwResult.compacted;
        console.log('[context-compress] sessions.compact result:', {
          sessionKey: input.sessionKey,
          compacted: gwResult.compacted,
          reason: gwResult.reason,
          tokensAfter: gwResult.tokensAfter,
        });
      } catch (_err) {
        // invokeSessionCompact already logs
      }

      if (gatewayCompacted) {
        compressed = true;
        compressionMeta = {
          summaryText: '',
          compressedCount: 0,
          totalMessagesAtCompression: input.messages.length,
          compressedTokens: estimatedTokens,
          compressedAt: now,
          isTruncation: false,
          gatewayCompacted: true,
        };
        input.onCompressionStatus?.({
          status: 'compressed',
          phase: 'before-send',
          sessionKey: input.sessionKey,
          startedAt: now,
          finishedAt: Date.now(),
          estimatedTokens,
          triggerTokens: budget.compressionTriggerTokens,
          hardLimitTokens: budget.hardLimitTokens,
        });
      } else {
        input.onCompressionStatus?.(null);
      }
    }
  }

  return { ...buildResult(input.messages, budget, compressed, undefined, gatewayCompacted), compressionMeta };
}
