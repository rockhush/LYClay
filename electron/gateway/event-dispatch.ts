import { GatewayEventType, type JsonRpcNotification } from './protocol';
import { logger } from '../utils/logger';

type GatewayEventEmitter = {
  emit: (event: string, payload: unknown) => boolean;
};

function getMessageText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const record = message as Record<string, unknown>;
  const direct = record.content ?? record.text;
  if (typeof direct === 'string') return direct;
  if (!Array.isArray(direct)) return '';
  return direct.map((block) => {
    if (!block || typeof block !== 'object') return '';
    const item = block as Record<string, unknown>;
    if (typeof item.text === 'string') return item.text;
    if (typeof item.content === 'string') return item.content;
    return '';
  }).filter(Boolean).join('\n');
}

function isInternalChatPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const event = payload as Record<string, unknown>;
  const message = event.message;
  if (!message || typeof message !== 'object') return false;
  const record = message as Record<string, unknown>;
  const text = getMessageText(message).trim();
  if (/^(HEARTBEAT_OK|NO_REPLY)$/i.test(text)) return true;
  if (/^\[?OpenClaw heartbeat poll\]?$/i.test(text)) return true;
  if (/^\[LYCLAW internal tool failure feedback\]/i.test(text)) return true;
  if (/^\[LYCLAW internal convergence directive\]/i.test(text)) return true;
  if (record.display === false && record.customType === 'openclaw.runtime-context') return true;
  if (/async command completion event was triggered/i.test(text)
    && /reply HEARTBEAT_OK only/i.test(text)) {
    return true;
  }
  return false;
}

export function dispatchProtocolEvent(
  emitter: GatewayEventEmitter,
  event: string,
  payload: unknown,
): void {
  switch (event) {
    case 'tick':
      break;
    case 'chat': {
      const chatState = (payload as Record<string, unknown>)?.state;
      logger.info(`[event] chat event received: state=${chatState}, runId=${(payload as Record<string, unknown>)?.runId}`);
      if (isInternalChatPayload(payload)) {
        logger.info('[event] suppressed internal chat event before renderer dispatch', {
          state: chatState,
          runId: (payload as Record<string, unknown>)?.runId,
        });
        break;
      }
      emitter.emit('chat:message', { message: payload });
      break;
    }
    case 'agent': {
      // Keep "agent" on the canonical notification path to avoid double
      // handling in renderer when both notification and chat-message are wired.
      emitter.emit('notification', { method: event, params: payload });
      break;
    }
    case 'channel.status':
    case 'channel.status_changed':
      emitter.emit('channel:status', payload as { channelId: string; status: string });
      break;
    case 'gateway.ready':
    case 'ready':
      emitter.emit('gateway:ready', payload);
      break;
    default:
      emitter.emit('notification', { method: event, params: payload });
  }
}

export function dispatchJsonRpcNotification(
  emitter: GatewayEventEmitter,
  notification: JsonRpcNotification,
): void {
  emitter.emit('notification', notification);
  switch (notification.method) {
    case GatewayEventType.CHANNEL_STATUS_CHANGED:
      emitter.emit('channel:status', notification.params as { channelId: string; status: string });
      break;
    case GatewayEventType.MESSAGE_RECEIVED:
      if (isInternalChatPayload((notification.params as { message?: unknown })?.message ?? notification.params)) {
        logger.info('[event] suppressed internal JSON-RPC chat notification before renderer dispatch');
        break;
      }
      emitter.emit('chat:message', notification.params as { message: unknown });
      break;
    case GatewayEventType.ERROR: {
      const errorData = notification.params as { message?: string };
      emitter.emit('error', new Error(errorData.message || 'Gateway error'));
      break;
    }
    default:
      logger.debug(`Unknown Gateway notification: ${notification.method}`);
  }
}
