import { describe, expect, it } from 'vitest';
import { extractRawFilePaths, isInternalMessage } from '@/stores/chat/helpers';

describe('chat internal message filter', () => {
  it('filters runtime system injection bundle like async exec completion payload', () => {
    const content = [
      'System (untrusted): [2026-04-22 10:06:24 GMT+8] Exec completed (nimbler, code 0) ...',
      'An async command you ran earlier has completed. The result is shown in the system messages above. Handle the result internally. Do not relay it to the user unless explicitly requested.',
      'Current time: Wednesday, April 22nd, 2026 - 10:06 (Asia/Shanghai) / 2026-04-22 02:06 UTC',
    ].join('\n\n');

    expect(isInternalMessage({ role: 'user', content })).toBe(true);
  });

  it('filters approved async command continuation notice from Gateway', () => {
    const content = [
      'An async command the user already approved has completed.',
      'Do not run the command again.',
      'If the task requires more steps, continue from this result before replying to the user.',
      'Exact completion details:',
      'Exec finished (gateway id=abc, session=rapid-canyon, code 0)',
      '{"success":true}',
      'Continue the task if needed, then reply to the user in a helpful way.',
    ].join('\n');

    expect(isInternalMessage({ role: 'user', content })).toBe(true);
  });

  it('filters denied async command notice from Gateway (user-denied)', () => {
    const content = [
      'An async command did not run.',
      'Do not run the command again.',
      'There is no new command output.',
      'Do not mention, summarize, or reuse output from any earlier run in this session.',
      '',
      'Exact completion details:',
      'Exec denied (gateway id=493eb6f2-cadc-4037-8f30-12878165a824, user-denied): Remove-Item -Path "D:\\测试\\hello.txt" -Force',
      '',
      'Reply to the user in a helpful way.',
      'Explain that the command did not run and why.',
      'Do not claim there is new command output.',
    ].join('\n');

    expect(isInternalMessage({ role: 'user', content })).toBe(true);
  });

  it('filters model-generated approve token command request', () => {
    const content = '需要你批准执行项目初始化命令。这是 project_manager.py init 创建 PPT 项目结构的第一步。请回复 /approve d0aebe53 来放行。';

    expect(isInternalMessage({ role: 'assistant', content })).toBe(true);
  });

  it('filters short approve-token initialization narration', () => {
    const content = 'Python 3.12.12 可用。请批准项目初始化：`/approve 3b612536`';

    expect(isInternalMessage({ role: 'assistant', content })).toBe(true);
  });

  it('filters short approve-token followup without explicit approval wording', () => {
    const content = '继续批一下：`/approve 954d3c37`';

    expect(isInternalMessage({ role: 'assistant', content })).toBe(true);
  });

  it('filters standalone current-time runtime ping', () => {
    const content = 'Current time: Wednesday, April 22nd, 2026 - 10:06 (Asia/Shanghai) / 2026-04-22 02:06 UTC';

    expect(isInternalMessage({ role: 'assistant', content })).toBe(true);
  });

  it('does not treat OpenClaw subagent completion events as internal filter targets', () => {
    const content = `[Internal task completion event]
source: subagent
session_key: agent:coder:subagent:child-123
session_id: child-session-id
status: completed successfully`;

    // Kept in transcript for run-lifecycle detection; hidden from chat bubbles in Chat page.
    expect(isInternalMessage({ role: 'user', content })).toBe(false);
  });

  it('filters standalone OpenClaw heartbeat poll message', () => {
    expect(isInternalMessage({ role: 'assistant', content: 'OpenClaw heartbeat poll' })).toBe(true);
    expect(isInternalMessage({ role: 'user', content: 'OpenClaw heartbeat poll' })).toBe(true);
    expect(isInternalMessage({ role: 'assistant', content: '[OpenClaw heartbeat poll]' })).toBe(true);
    expect(isInternalMessage({ role: 'user', content: '[OpenClaw heartbeat poll]' })).toBe(true);
  });

  it('filters the contentless failed-turn placeholder (request timed out)', () => {
    expect(isInternalMessage({
      role: 'assistant',
      content: '[assistant turn failed before producing content]',
    })).toBe(true);
    expect(isInternalMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'assistant turn failed before producing content' }],
    })).toBe(true);
  });

  it('does not filter a normal assistant message that merely mentions a failed turn', () => {
    const content = 'The previous assistant turn failed before producing content because the request timed out — here is what to try next.';

    expect(isInternalMessage({ role: 'assistant', content })).toBe(false);
  });

  it('filters internal tool failure feedback control messages', () => {
    const content = [
      '[LYCLAW internal tool failure feedback]',
      'The exec tool timed out after 120s. Cleanup status: succeeded.',
      'This is internal control feedback from the runtime.',
    ].join('\n');

    expect(isInternalMessage({ role: 'user', content })).toBe(true);
  });

  it('does not filter normal user message that starts with current time', () => {
    const content = 'Current time: 北京现在几点？';

    expect(isInternalMessage({ role: 'user', content })).toBe(false);
  });

  it('does not filter normal user text that merely mentions the heartbeat label', () => {
    const content = '为什么我会看到 [OpenClaw heartbeat poll] 这个消息？';

    expect(isInternalMessage({ role: 'user', content })).toBe(false);
  });

  it('does not filter normal assistant text that mentions async completion phrase only', () => {
    const content = 'The sentence "An async command you ran earlier has completed" is just an example in docs.';

    expect(isInternalMessage({ role: 'assistant', content })).toBe(false);
  });

  it('does not extract preview candidates for globs or Windows-invalid Unix-root paths', () => {
    const originalPlatform = navigator.platform;
    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      value: 'Win32',
    });

    try {
      const refs = extractRawFilePaths([
        'D:\\*.svg',
        '/scripts/README.md',
        '/templates/icons/README.md',
        'C:\\Users\\Leon.Long\\.openclaw\\skills\\ppt-master\\SKILL.md',
      ].join('\n'));

      expect(refs).toEqual([
        {
          filePath: 'C:\\Users\\Leon.Long\\.openclaw\\skills\\ppt-master\\SKILL.md',
          mimeType: 'text/markdown',
        },
      ]);
    } finally {
      Object.defineProperty(navigator, 'platform', {
        configurable: true,
        value: originalPlatform,
      });
    }
  });
});
