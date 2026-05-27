import i18n from '@/i18n';
import { hostApiFetch } from '@/lib/host-api';
import { estimateHistoryTokens, estimateMessageTokens } from '@/lib/token-estimator';
import { useAgentsStore } from '@/stores/agents';
import { useSettingsStore } from '@/stores/settings';
import { compressHistory, type InvokeRpcFn } from './context-compactor';
import { DEFAULT_CONTEXT_WINDOW, resolveContextBudget, type ContextBudget } from './context-budget';
import type { RawMessage } from './types';

export type ContextSendGuardError = 'contextTooLarge' | 'currentMessageTooLarge';

export interface ContextSendGuardResult {
  messages: RawMessage[];
  compressed: boolean;
  budget: ContextBudget;
  error?: ContextSendGuardError;
  errorMessage?: string;
}

export interface PrepareContextBeforeSendInput {
  sessionKey: string;
  messages: RawMessage[];
  pendingUserMessage: RawMessage;
  runtimeMessage: string;
  workspaceContext?: string;
  isInternalStagedExecution: boolean;
  invokeCompactorRpc: InvokeRpcFn;
}

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

async function resolveContextWindowForSession(sessionKey: string): Promise<number> {
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
): ContextSendGuardResult {
  return {
    messages,
    budget,
    compressed,
    error,
    errorMessage: error === 'currentMessageTooLarge'
      ? getCurrentMessageTooLargeMessage()
      : error === 'contextTooLarge'
        ? getContextTooLargeMessage()
        : undefined,
  };
}

export async function prepareContextBeforeSend(input: PrepareContextBeforeSendInput): Promise<ContextSendGuardResult> {
  const contextWindow = await resolveContextWindowForSession(input.sessionKey);
  const budget = resolveContextBudget(contextWindow);

  if (input.isInternalStagedExecution || input.sessionKey === '__compactor__') {
    return buildResult(input.messages, budget, false);
  }

  const { contextCompressionEnabled } = useSettingsStore.getState();
  const pendingRuntimeMessage = buildPendingRuntimeMessage(input);
  const pendingMessageTokens = estimateMessageTokens(pendingRuntimeMessage.content);

  if (pendingMessageTokens > Math.floor(budget.hardLimitTokens * 0.9)) {
    return buildResult(input.messages, budget, false, 'currentMessageTooLarge');
  }

  let nextMessages = input.messages;
  let compressed = false;
  let estimatedTokens = estimateHistoryTokens([...nextMessages, pendingRuntimeMessage]);

  if (contextCompressionEnabled && nextMessages.length >= 10 && estimatedTokens >= budget.compressionTriggerTokens) {
    const compression = await compressHistory(
      nextMessages,
      input.sessionKey,
      input.invokeCompactorRpc,
      {
        threshold: budget.compressionTriggerTokens,
        keepRecentTokens: budget.recentRawTokens,
        summaryTokens: budget.summaryTokens,
        hardLimitTokens: budget.hardLimitTokens,
      },
    );

    if (compression) {
      nextMessages = [compression.summaryMessage, ...compression.compressedMessages];
      compressed = true;
      estimatedTokens = estimateHistoryTokens([...nextMessages, pendingRuntimeMessage]);
      console.log('[context-send-guard] compressed context before send', {
        sessionKey: input.sessionKey,
        originalCount: compression.originalCount,
        estimatedTokens,
        hardLimitTokens: budget.hardLimitTokens,
        contextWindow: budget.contextWindow,
      });
    }
  }

  if (estimatedTokens > budget.hardLimitTokens) {
    return buildResult(nextMessages, budget, compressed, 'contextTooLarge');
  }

  return buildResult(nextMessages, budget, compressed);
}
