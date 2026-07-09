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
  isCumulativeRunFinalText,
  isRunTerminalAssistantMessage,
  isSilentTerminalAssistantMessage,
  isTerminalAssistantMessage,
  shouldKeepRunActiveAfterAssistantFinal,
  shouldSilentlyFinalizeRunOnAssistantFinal,
  stripRendererSyntheticRunMessages,
  transcriptHasCommittedConcludingReply,
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
    expect(isChannelDeliveryConfirmationText('sent message via dingtalk')).toBe(true);
    expect(isChannelDeliveryConfirmationText('message sent through dingtalk\n\nNO_REPLY')).toBe(true);
  });

  it('does not treat pre-tool DingTalk planning as a delivery confirmation', () => {
    expect(isChannelDeliveryConfirmationText('I will send the meeting notice through DingTalk next.')).toBe(false);
    expect(isChannelDeliveryConfirmationText('Let me prepare the note before sending it via DingTalk.')).toBe(false);
  });

  it('filters assistant echoes of outbound channel payloads', () => {
    const messages: RawMessage[] = [
      { role: 'user', content: 'Send Alice this message: meeting tomorrow', id: 'u1', timestamp: 1 },
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 't1', name: 'message_send', arguments: { text: 'meeting tomorrow' } }],
        id: 'a1',
        timestamp: 2,
      },
      { role: 'assistant', content: 'meeting tomorrow', id: 'a2', timestamp: 3 },
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
      content: [{ type: 'text', text: 'Preparing the generation script.' }],
      stopReason: 'aborted',
      errorMessage: 'Request was aborted',
      timestamp: 1001,
    };

    expect(isTerminalAssistantMessage(message)).toBe(false);
    expect(isRunTerminalAssistantMessage(message)).toBe(false);
    expect(findTerminalAssistantAfterLatestUser([
      { role: 'user', content: 'Generate PPT', id: 'u1', timestamp: 1000 },
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
      { role: 'user', content: 'Generate PPT', id: 'u1', timestamp: 1000 },
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
        content: [{ type: 'text', text: 'PPT generated. Please review the attachment.' }],
        id: 'a-final-no-stop',
        timestamp: 4000,
      },
    ];

    expect(isRunTerminalAssistantMessage(messages[3])).toBe(false);
    expect(findConcludingAssistantReply(messages.slice(1))?.id).toBe('a-final-no-stop');
    expect(hasCommittedUserReplyInMessages(messages.slice(1))).toBe(true);
    expect(findConcludingAssistantForActiveTurn(messages, 1000)?.id).toBe('a-final-no-stop');
  });

  it('treats post-tool visible text with co-located tool_use as concluding', () => {
    const messages: RawMessage[] = [
      { role: 'user', content: 'analyze', id: 'u1', timestamp: 1000 },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'process', input: {} }],
        id: 'a1',
        timestamp: 2000,
      },
      { role: 'toolresult', toolCallId: 't1', content: 'ok', timestamp: 3000 },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'All three requests timed out.' },
          { type: 'tool_use', id: 't2', name: 'image', input: {} },
        ],
        id: 'a-final-mixed',
        timestamp: 4000,
      },
    ];

    expect(findConcludingAssistantReply(messages.slice(1))?.id).toBe('a-final-mixed');
    expect(transcriptHasCommittedConcludingReply(messages, 1000)).toBe(true);
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
      content: 'sent message via dingtalk\n\nNO_REPLY',
      stopReason: 'stop',
    })).toBe(true);
  });

  it('does not finalize approve narration or pre-tool channel planning', () => {
    expect(shouldSilentlyFinalizeRunOnAssistantFinal({
      role: 'assistant',
      content: 'Please reply /approve d0aebe53 to continue.',
      stopReason: 'stop',
    })).toBe(false);

    expect(shouldSilentlyFinalizeRunOnAssistantFinal({
      role: 'assistant',
      content: 'I will send the meeting notice through DingTalk next.',
      stopReason: 'toolUse',
    })).toBe(false);

    expect(shouldKeepRunActiveAfterAssistantFinal({
      role: 'assistant',
      content: 'Please reply /approve d0aebe53 to continue.',
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
    expect(shouldSuppressAssistantStreamingText('Please reply /approve d0aebe53 to continue.')).toBe(false);
    expect(shouldSuppressAssistantStreamingText('I will send the meeting notice through DingTalk next.')).toBe(false);
  });
});

describe('renderer synthetic run messages', () => {
  it('strips optimistic run-* finals when authoritative assistant messages exist', () => {
    const messages: RawMessage[] = [
      { role: 'user', content: 'send file', timestamp: 1000 },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '找到机器人了。' },
          { type: 'tool_use', id: 't1', name: 'exec', input: {} },
        ],
        stopReason: 'toolUse',
        timestamp: 2000,
      },
      { role: 'assistant', content: '发送成功！', stopReason: 'stop', timestamp: 3000 },
      {
        role: 'assistant',
        id: 'run-5ac41c40-7449-41c5-a7de-4dc250219356',
        content: '好，我来发送。找到机器人了。发送成功！',
        timestamp: 3001,
      },
    ];

    const stripped = stripRendererSyntheticRunMessages(messages);
    expect(stripped).toHaveLength(3);
    expect(findConcludingAssistantReply(stripped)?.content).toBe('发送成功！');
    expect(findTerminalAssistantAfterLatestUser(stripped)?.content).toBe('发送成功！');
  });

  it('detects cumulative gateway finals that embed prior narration', () => {
    const turnMessages: RawMessage[] = [
      { role: 'assistant', content: '好，我来把截图通过钉钉机器人发给你。首先需要上传图片获取 mediaId：' },
      { role: 'assistant', content: '找到机器人了。接下来我需要先通过聊天消息接口查询自己的会话 ID。' },
    ];
    const cumulative = [
      turnMessages[0]?.content,
      turnMessages[1]?.content,
      '发送成功！',
    ].join('');

    expect(isCumulativeRunFinalText(cumulative, turnMessages)).toBe(true);
    expect(isCumulativeRunFinalText('发送成功！', turnMessages)).toBe(false);
  });

  it('does not treat partial phase wait as concluding reply', () => {
    const messages: RawMessage[] = [
      { role: 'user', content: 'make ppt', timestamp: 1000 },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'sessions_spawn', input: {} }],
        stopReason: 'toolUse',
      },
      { role: 'toolResult', toolCallId: 't1', content: 'ok' },
      {
        role: 'assistant',
        content: 'Phase 1（slides 1-5）也完成了！✅ 继续等待 Phase 3（slides 11-15）～',
        stopReason: 'stop',
        timestamp: 3000,
      },
    ];
    expect(findConcludingAssistantReply(messages)).toBeUndefined();
    expect(transcriptHasCommittedConcludingReply(messages, 1000)).toBe(false);
  });

  it('does not treat tool-round narration as committed concluding reply', () => {
    const messages: RawMessage[] = [
      { role: 'user', content: 'analyze skill', timestamp: 1000 },
      {
        role: 'assistant',
        content: '我先读取技能文档。',
        stopReason: 'toolUse',
        timestamp: 2000,
      },
    ];
    expect(transcriptHasCommittedConcludingReply(messages, 1000)).toBe(false);
  });

  it('does not treat bundled narration+tool_call as committed while backend is active', () => {
    const messages: RawMessage[] = [
      { role: 'user', content: '/think medium @testLYAI process file', timestamp: 1000 },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '我先读取 testLYAI 技能的说明文档。' },
          { type: 'toolCall', id: 'read-1', name: 'read', arguments: {} },
        ],
        stopReason: 'toolUse',
        timestamp: 2000,
      },
    ];
    expect(transcriptHasCommittedConcludingReply(messages, 1000)).toBe(false);
  });

  it('recovers turn anchor when lastUserMessageAt was cleared mid-run', () => {
    const messages: RawMessage[] = [
      { role: 'user', content: 'analyze skill', timestamp: 1000 },
      {
        role: 'assistant',
        content: '我先读取技能文档。',
        stopReason: 'toolUse',
        timestamp: 2000,
      },
    ];
    expect(transcriptHasCommittedConcludingReply(messages, null)).toBe(false);
  });

  it('does not treat trailing embedded agent failure notice as concluding reply', () => {
    const messages: RawMessage[] = [
      { role: 'user', content: 'process excel', timestamp: 1000 },
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'exec-1', name: 'exec', arguments: {} }],
        stopReason: 'toolUse',
        timestamp: 2000,
      },
      {
        role: 'assistant',
        content: '✅ 运行成功！来看看填表结果。',
        stopReason: 'stop',
        timestamp: 3000,
      },
      {
        role: 'assistant',
        content: '⚠️ Agent failed before reply: All models failed (1): custom-customb5/deepseek-v4-pro: Provider custom-customb5 is in cooldown (suspending lanes) (timeout).',
        stopReason: 'stop',
        timestamp: 4000,
      },
    ];
    expect(findConcludingAssistantReply(messages.slice(1))?.content).toBe('✅ 运行成功！来看看填表结果。');
    expect(transcriptHasCommittedConcludingReply(messages, 1000)).toBe(true);
  });
});
