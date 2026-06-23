import { describe, expect, it } from 'vitest';
import { extractText } from '@/pages/Chat/message-utils';

describe('extractText cron message cleanup', () => {
  it('removes the [cron:id] prefix, reformats time to Chinese, and drops the delivery instruction', () => {
    const content = [
      '[cron:b425ca0d-e57c-4593-9596-88db50bfd866] 游戏1 是时候去打两把游戏了',
      'Current time: Tuesday, June 23rd, 2026 - 13:22 (Asia/Shanghai)',
      'Reference UTC: 2026-06-23 05:22 UTC',
      '',
      'Use the message tool if you need to notify the user directly for the current chat. If you do not send directly, your final plain-text reply will be delivered automatically.',
    ].join('\n');

    const result = extractText({ role: 'user', content });

    expect(result).toContain('游戏1 是时候去打两把游戏了');
    expect(result).toContain('时间：2026年6月23日 13:22:00');
    expect(result).not.toContain('cron:');
    expect(result).not.toContain('Current time');
    expect(result).not.toContain('Reference UTC');
    expect(result).not.toContain('Use the message tool');
  });

  it('still hides the standalone heartbeat time ping (no Reference UTC line)', () => {
    const content = 'Current time: Wednesday, April 22nd, 2026 - 10:06 (Asia/Shanghai) / 2026-04-22 02:06 UTC';
    expect(extractText({ role: 'user', content })).toBe('');
  });

  it('leaves a normal user message untouched', () => {
    const content = '帮我查一下今天的天气';
    expect(extractText({ role: 'user', content })).toBe('帮我查一下今天的天气');
  });
});
