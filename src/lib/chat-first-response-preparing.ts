/**
 * Matches Chat page `showFirstResponseProgress` / FirstResponsePreparing visibility
 * so other UI (e.g. sidebar) can align session-switch policy without duplicating logic.
 */
import type { GatewayStatus } from '@/types/gateway';
import type { ContentBlock, RawMessage, ToolStatus } from '@/stores/chat/types';
import { extractImages, extractText, extractThinking, extractToolUse } from '@/pages/Chat/message-utils';

export type FirstResponsePreparingInput = {
  gatewayStatus: Pick<GatewayStatus, 'state' | 'warmupStatus'>;
  sending: boolean;
  streamingMessage: RawMessage | string | null;
  streamingText: string;
  streamingTools: ToolStatus[];
};

function hasThinkingBlock(message: RawMessage | null): boolean {
  if (!message || !Array.isArray(message.content)) return false;
  return (message.content as ContentBlock[]).some((block) => block.type === 'thinking');
}

function hasToolCall(message: RawMessage | null): boolean {
  if (!message) return false;
  const msg = message as unknown as Record<string, unknown>;
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) return true;
  if (Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0) return true;
  if (!Array.isArray(message.content)) return false;
  return (message.content as ContentBlock[]).some((block) => block.type === 'tool_use' || block.type === 'toolCall');
}

export type ChatWaitingMode = 'warming' | 'stuck' | 'normal';

type ChatWaitingModeInput = FirstResponsePreparingInput & {
  gatewayStatus: Pick<GatewayStatus, 'state' | 'warmupStatus' | 'lastStuckSessionAt'>;
};

export function isFirstResponsePreparing(input: FirstResponsePreparingInput): boolean {
  const isGatewayRunning = input.gatewayStatus.state === 'running';
  const warmupStatus = input.gatewayStatus.warmupStatus;
  const streamMsg = input.streamingMessage && typeof input.streamingMessage === 'object'
    ? (input.streamingMessage as RawMessage)
    : null;
  const streamText = streamMsg
    ? extractText(streamMsg)
    : (typeof input.streamingMessage === 'string' ? input.streamingMessage : input.streamingText || '');
  const hasStreamText = streamText.trim().length > 0;
  const streamThinking = streamMsg ? extractThinking(streamMsg) : null;
  const hasStreamThinking = !!streamThinking && streamThinking.trim().length > 0;
  const hasStreamThinkingBlock = hasThinkingBlock(streamMsg);
  const streamTools = streamMsg ? extractToolUse(streamMsg) : [];
  const hasStreamTools = streamTools.length > 0 || hasToolCall(streamMsg);
  const streamImages = streamMsg ? extractImages(streamMsg) : [];
  const hasStreamImages = streamImages.length > 0;
  const hasStreamToolStatus = input.streamingTools.length > 0;
  const hasAnyStreamContent = hasStreamText || hasStreamThinking || hasStreamThinkingBlock || hasStreamTools || hasStreamImages || hasStreamToolStatus;

  return isGatewayRunning
    && input.sending
    && warmupStatus !== 'ready'
    && warmupStatus !== 'failed'
    && !hasAnyStreamContent;
}

function hasAnyStreamPayload(input: FirstResponsePreparingInput): boolean {
  const streamMsg = input.streamingMessage && typeof input.streamingMessage === 'object'
    ? input.streamingMessage as RawMessage
    : null;

  return input.streamingText.trim().length > 0
    || (typeof input.streamingMessage === 'string' && input.streamingMessage.trim().length > 0)
    || (streamMsg
      ? extractText(streamMsg).trim().length > 0
        || (extractThinking(streamMsg)?.trim().length ?? 0) > 0
        || extractToolUse(streamMsg).length > 0
        || extractImages(streamMsg).length > 0
      : false)
    || input.streamingTools.length > 0;
}

export function getChatWaitingMode(input: ChatWaitingModeInput): ChatWaitingMode {
  if (input.gatewayStatus.state === 'running'
    && input.sending
    && input.gatewayStatus.lastStuckSessionAt
    && !isFirstResponsePreparing({
      gatewayStatus: input.gatewayStatus,
      sending: input.sending,
      streamingMessage: input.streamingMessage,
      streamingText: input.streamingText,
      streamingTools: input.streamingTools,
    })) {
    if (!hasAnyStreamPayload(input)) {
      return 'stuck';
    }
  }

  if (isFirstResponsePreparing(input)) {
    return 'warming';
  }

  return 'normal';
}
