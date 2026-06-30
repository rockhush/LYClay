import { describe, expect, it } from 'vitest';
import {
  filterChannelOutboundEchoMessages,
  isChannelDeliveryConfirmationText,
  shouldSuppressAssistantStreamingText,
  stripSilentReplyToken,
} from '@/stores/chat/helpers';
import {
  findConcludingAssistantForActiveTurn,
  findConcludingAssistantReply,
  findTerminalAssistantAfterLatestUser,
  findTerminalAssistantForActiveTurn,
  hasCommittedUserReplyInMessages,
  isRunTerminalAssistantMessage,
  isSilentTerminalAssistantMessage,
  isTerminalAssistantMessage,
  shouldKeepRunActiveAfterAssistantFinal,
  shouldSilentlyFinalizeRunOnAssistantFinal,
} from '@/stores/chat/run-lifecycle';
import type { RawMessage } from '@/stores/chat/types';

describe('stripSilentReplyToken', () => {
  it('removes trailing NO_REPLY after DingTalk send narration', () => {
    expect(stripSilentReplyToken('Sent via DingTalk\n\nNO_REPLY')).toBe('Sent via DingTalk');
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

  it('does not treat pre-tool DingTalk planning as a delivery confirmation', () => {
    expect(isChannelDeliveryConfirmationText('接下来我会通过钉钉发送会议通知。')).toBe(false);
    expect(isChannelDeliveryConfirmationText('我先整理内容，再通过钉钉发送给张三。')).toBe(false);
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
  });

  it('does not treat length-truncated assistant output as terminal', () => {
    const message: RawMessage = {
      role: 'assistant',
      content: 'Creating the requested PPT',
      stopReason: 'length',
      timestamp: 1002,
    };

    expect(isRunTerminalAssistantMessage(message)).toBe(false);
  });

  it('keeps tool-use assistant turns non-terminal', () => {
    const message: RawMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Reading skill docs' }],
      stopReason: 'toolUse',
      timestamp: 1003,
    };

    expect(isRunTerminalAssistantMessage(message)).toBe(false);
  });

  it('treats explicit stop assistant output as terminal', () => {
    const message: RawMessage = {
      role: 'assistant',
      content: 'Done',
      stopReason: 'stop',
      timestamp: 1004,
    };

    expect(isRunTerminalAssistantMessage(message)).toBe(true);
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

  it('ignores a prior turn terminal assistant when the active turn started later', () => {
    const messages: RawMessage[] = [
      { role: 'user', content: 'first', id: 'u1', timestamp: 1000 },
      { role: 'assistant', content: 'answer one', stopReason: 'stop', id: 'a1', timestamp: 1001 },
      { role: 'user', content: 'second', id: 'u2', timestamp: 2000 },
    ];

    expect(findTerminalAssistantForActiveTurn(messages, 2000)).toBeUndefined();
    expect(findTerminalAssistantAfterLatestUser([
      { role: 'user', content: 'first', id: 'u1', timestamp: 1000 },
      { role: 'assistant', content: 'answer one', stopReason: 'stop', id: 'a1', timestamp: 1001 },
    ])).toMatchObject({ id: 'a1' });
    expect(findTerminalAssistantForActiveTurn([
      { role: 'user', content: 'first', id: 'u1', timestamp: 1000 },
      { role: 'assistant', content: 'answer one', stopReason: 'stop', id: 'a1', timestamp: 1001 },
    ], 2000)).toBeUndefined();
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

  it('does not treat thinking-only assistant turns as terminal replies', () => {
    const message: RawMessage = {
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'planning the reply' }],
      stopReason: 'stop',
      id: 'a-thinking-only',
      timestamp: 1001,
    };

    expect(isTerminalAssistantMessage(message)).toBe(false);
    expect(isRunTerminalAssistantMessage(message)).toBe(false);
    expect(findTerminalAssistantAfterLatestUser([
      { role: 'user', content: 'send image', id: 'u1', timestamp: 1000 },
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

  it('keeps run active for narration-only interim finals without explicit stop reason', () => {
    const message: RawMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Checking the files next.' }],
      id: 'a-narration',
      timestamp: 1001,
    };

    expect(shouldKeepRunActiveAfterAssistantFinal(message)).toBe(true);
  });

  it('clears run active only for explicit terminal assistant finals', () => {
    const message: RawMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'All done.' }],
      stopReason: 'stop',
      id: 'a-final',
      timestamp: 1001,
    };

    expect(shouldKeepRunActiveAfterAssistantFinal(message)).toBe(false);
  });

  it('treats post-tool text-only replies as concluding even without stopReason', () => {
    const messages: RawMessage[] = [
      { role: 'user', content: 'build ppt', id: 'u1', timestamp: 1000 },
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 't1', name: 'exec', arguments: {} }],
        stopReason: 'toolUse',
        id: 'a1',
        timestamp: 2000,
      },
      { role: 'toolresult', toolCallId: 't1', content: 'ok', timestamp: 3000 },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'PPT 已生成，请查看附件。' }],
        id: 'a-final-no-stop',
        timestamp: 4000,
      },
    ];

    expect(isRunTerminalAssistantMessage(messages[3])).toBe(false);
    expect(findConcludingAssistantReply(messages.slice(1))?.id).toBe('a-final-no-stop');
    expect(hasCommittedUserReplyInMessages(messages.slice(1))).toBe(true);
    expect(findConcludingAssistantForActiveTurn(messages, 1000)?.id).toBe('a-final-no-stop');
  });

  it('does not treat pre-tool narration as concluding', () => {
    const messages: RawMessage[] = [
      { role: 'user', content: 'go', id: 'u1', timestamp: 1000 },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Checking the files next.' }],
        id: 'a-narration',
        timestamp: 1001,
      },
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 't1', name: 'read', arguments: {} }],
        stopReason: 'toolUse',
        id: 'a1',
        timestamp: 1002,
      },
    ];

    expect(findConcludingAssistantReply(messages.slice(1))).toBeUndefined();
  });
});

describe('silent run finalization whitelist', () => {
  it('finalizes only explicit silent plumbing with terminal stop reason', () => {
    expect(shouldSilentlyFinalizeRunOnAssistantFinal({
      role: 'assistant',
      content: 'NO_REPLY',
      stopReason: 'stop',
    })).toBe(true);

    expect(shouldSilentlyFinalizeRunOnAssistantFinal({
      role: 'assistant',
      content: '已通过钉钉发送。\n\nNO_REPLY',
      stopReason: 'stop',
    })).toBe(true);
  });

  it('does not finalize approve narration or pre-tool channel planning', () => {
    expect(shouldSilentlyFinalizeRunOnAssistantFinal({
      role: 'assistant',
      content: '请回复 /approve d0aebe53 来放行。',
      stopReason: 'stop',
    })).toBe(false);

    expect(shouldSilentlyFinalizeRunOnAssistantFinal({
      role: 'assistant',
      content: '接下来我会通过钉钉发送会议通知。',
      stopReason: 'toolUse',
    })).toBe(false);

    expect(shouldKeepRunActiveAfterAssistantFinal({
      role: 'assistant',
      content: '请回复 /approve d0aebe53 来放行。',
      stopReason: 'toolUse',
    })).toBe(true);
  });

  it('does not finalize bare NO_REPLY without terminal stop reason', () => {
    expect(shouldSilentlyFinalizeRunOnAssistantFinal({
      role: 'assistant',
      content: 'NO_REPLY',
    })).toBe(false);
  });

  it('suppresses streaming only for silent tokens, not approval narration', () => {
    expect(shouldSuppressAssistantStreamingText('NO_REPLY')).toBe(true);
    expect(shouldSuppressAssistantStreamingText('请回复 /approve d0aebe53 来放行。')).toBe(false);
    expect(shouldSuppressAssistantStreamingText('接下来我会通过钉钉发送会议通知。')).toBe(false);
  });
});
