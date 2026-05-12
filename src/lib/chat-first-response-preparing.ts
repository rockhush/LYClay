/**
 * Matches Chat page `showFirstResponseProgress` / FirstResponsePreparing visibility
 * so other UI (e.g. sidebar) can align session-switch policy without duplicating logic.
 */
import type { GatewayStatus } from '@/types/gateway';
import type { RawMessage, ToolStatus } from '@/stores/chat/types';
import { extractImages, extractText, extractThinking, extractToolUse } from '@/pages/Chat/message-utils';

export type FirstResponsePreparingInput = {
  gatewayStatus: Pick<GatewayStatus, 'state' | 'warmupStatus'>;
  sending: boolean;
  streamingMessage: RawMessage | string | null;
  streamingText: string;
  streamingTools: ToolStatus[];
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
  const streamTools = streamMsg ? extractToolUse(streamMsg) : [];
  const hasStreamTools = streamTools.length > 0;
  const streamImages = streamMsg ? extractImages(streamMsg) : [];
  const hasStreamImages = streamImages.length > 0;
  const hasStreamToolStatus = input.streamingTools.length > 0;
  const hasAnyStreamContent = hasStreamText || hasStreamThinking || hasStreamTools || hasStreamImages || hasStreamToolStatus;

  return isGatewayRunning
    && input.sending
    && warmupStatus !== 'ready'
    && !hasAnyStreamContent;
}
