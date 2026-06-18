import { describe, expect, it } from 'vitest';
import { stripSilentReplyToken } from '@/stores/chat/helpers';
import {
  isRunTerminalAssistantMessage,
  isSilentTerminalAssistantMessage,
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
