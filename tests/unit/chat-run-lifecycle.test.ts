import { describe, expect, it } from 'vitest';
import {
  filterChannelOutboundEchoMessages,
  isChannelDeliveryConfirmationText,
  stripSilentReplyToken,
} from '@/stores/chat/helpers';
import {
  findTerminalAssistantAfterLatestUser,
  isRunTerminalAssistantMessage,
  isSilentTerminalAssistantMessage,
  isTerminalAssistantMessage,
} from '@/stores/chat/run-lifecycle';
import type { RawMessage } from '@/stores/chat/types';

describe('stripSilentReplyToken', () => {
  it('removes trailing NO_REPLY after DingTalk send narration', () => {
    expect(stripSilentReplyToken('已通过钉钉发送。\n\nNO_REPLY')).toBe('已通过钉钉发送。');
  });

  it('clears a silent-only reply', () => {
    expect(stripSilentReplyToken('NO_REPLY')).toBe('');
  });
});

describe('channel delivery assistant filtering', () => {
  it('treats DingTalk delivery confirmations as internal text', () => {
    expect(isChannelDeliveryConfirmationText('已通过钉钉发送。\n\nNO_REPLY')).toBe(true);
    expect(isChannelDeliveryConfirmationText('已向张三发送消息。')).toBe(true);
  });

  it('filters assistant echoes of outbound channel payloads', () => {
    const messages: RawMessage[] = [
      { role: 'user', content: '给李四发消息：明天开会', id: 'u1', timestamp: 1 },
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 't1', name: 'message_send', arguments: { text: '明天开会' } }],
        id: 'a1',
        timestamp: 2,
      },
      { role: 'assistant', content: '明天开会', id: 'a2', timestamp: 3 },
    ];

    const filtered = filterChannelOutboundEchoMessages(messages);
    expect(filtered.map((message) => message.id)).toEqual(['u1', 'a1']);
  });
});

describe('chat run lifecycle helpers', () => {
  it('treats NO_REPLY with stop reason as a silent terminal assistant message', () => {
    const message: RawMessage = {
      role: 'assistant',
      content: 'NO_REPLY',
      stopReason: 'stop',
      timestamp: 1001,
    };

    expect(isSilentTerminalAssistantMessage(message)).toBe(true);
    expect(isRunTerminalAssistantMessage(message)).toBe(true);
  });

  it('does not treat NO_REPLY without stop reason as terminal', () => {
    const message: RawMessage = {
      role: 'assistant',
      content: 'NO_REPLY',
      timestamp: 1001,
    };

    expect(isSilentTerminalAssistantMessage(message)).toBe(false);
    expect(isRunTerminalAssistantMessage(message)).toBe(false);
  });

  it('finds terminal assistant only after the latest visible user turn', () => {
    const messages: RawMessage[] = [
      { role: 'user', content: 'older question', id: 'u0', timestamp: 1 },
      { role: 'assistant', content: 'older answer', stopReason: 'stop', id: 'a0', timestamp: 2 },
      { role: 'user', content: 'new question', id: 'u1', timestamp: 3 },
      { role: 'assistant', content: [{ type: 'toolCall', id: 't1', name: 'read', arguments: {} }], stopReason: 'toolUse', id: 'a1', timestamp: 4 },
    ];

    expect(findTerminalAssistantAfterLatestUser(messages)).toBeUndefined();

    messages.push({
      role: 'assistant',
      content: 'done',
      stopReason: 'stop',
      id: 'a2',
      timestamp: 5,
    });

    expect(findTerminalAssistantAfterLatestUser(messages)?.id).toBe('a2');
  });

  it('does not treat aborted assistant turns as successful terminal replies', () => {
    const message: RawMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: '环境确认完毕，开始写生成脚本。' }],
      stopReason: 'aborted',
      errorMessage: 'Request was aborted',
      timestamp: 1001,
    };

    expect(isTerminalAssistantMessage(message)).toBe(false);
    expect(isRunTerminalAssistantMessage(message)).toBe(false);
    expect(findTerminalAssistantAfterLatestUser([
      { role: 'user', content: '生成 PPT', id: 'u1', timestamp: 1000 },
      message,
    ])).toBeUndefined();
  });

  it('does not treat stopReason=error assistant turns as successful terminal replies', () => {
    const message: RawMessage = {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: '404 Resource not found',
      timestamp: 1001,
    };

    expect(isTerminalAssistantMessage(message)).toBe(false);
    expect(isRunTerminalAssistantMessage(message)).toBe(false);
  });
});
