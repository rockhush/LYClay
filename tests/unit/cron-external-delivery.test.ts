import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const testOpenClawConfigDir = join(tmpdir(), 'lyclaw-tests', 'cron-external-delivery');

vi.mock('../../electron/utils/paths', () => ({
  getOpenClawConfigDir: () => testOpenClawConfigDir,
}));

import {
  buildScheduledTaskInAppSystemPrompt,
  clearExternalCronDeliveryState,
  handleExternalCronChatTerminal,
  looksLikeRecipientClarification,
  registerExternalCronDeliveryPending,
  resolveExternalCronDeliveryText,
} from '../../electron/gateway/cron-external-delivery';

describe('cron external delivery', () => {
  beforeEach(() => {
    clearExternalCronDeliveryState();
  });

  it('builds in-app-only guidance without outbound target prompts', () => {
    const prompt = buildScheduledTaskInAppSystemPrompt();
    expect(prompt).toContain('Do NOT use the `message` tool');
    expect(prompt).toContain('Do NOT ask who to send to');
    expect(prompt).not.toContain('target=');
  });

  it('detects recipient clarification replies', () => {
    expect(looksLikeRecipientClarification('发送给谁？请提供接收人的名字')).toBe(true);
    expect(looksLikeRecipientClarification('NBA历史第一人是乔丹')).toBe(false);
  });

  it('falls back to the cron task message when assistant asks for recipient', () => {
    expect(resolveExternalCronDeliveryText('发送给谁？', '发送钉钉消息：起来吧')).toBe('发送钉钉消息：起来吧');
    expect(resolveExternalCronDeliveryText('起来吧', '发送钉钉消息：起来吧')).toBe('起来吧');
  });

  it('delivers via gateway send RPC when the scheduled run completes', async () => {
    registerExternalCronDeliveryPending({
      jobId: 'job-dingtalk',
      runSessionId: 'run-1',
      sessionKey: 'agent:main:scheduled-task:job-dingtalk:run-1',
      runId: 'run-dingtalk',
      agentId: 'main',
      taskMessage: '发送钉钉消息：起来吧',
      deliveryContext: {
        channel: 'dingtalk',
        to: '11427193',
        accountId: 'default',
      },
      registeredAtMs: Date.now(),
    });

    const rpc = vi.fn(async () => ({}));
    await handleExternalCronChatTerminal({
      rpc,
      runId: 'run-dingtalk',
      sessionKey: 'agent:main:scheduled-task:job-dingtalk:run-1',
      state: 'final',
      message: { role: 'assistant', content: '起来吧' },
    });

    expect(rpc).toHaveBeenCalledWith('send', expect.objectContaining({
      channel: 'dingtalk',
      to: '11427193',
      accountId: 'default',
      message: '起来吧',
      agentId: 'main',
    }), 60_000);
  });

  it('reads assistant text from transcript when final event asks for recipient', async () => {
    const sessionsDir = join(testOpenClawConfigDir, 'agents', 'main', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, 'sessions.json'),
      JSON.stringify({
        'agent:main:scheduled-task:job-dingtalk:run-1': {
          id: 'run-1',
        },
      }),
      'utf8',
    );
    writeFileSync(
      join(sessionsDir, 'run-1.jsonl'),
      [
        JSON.stringify({ type: 'message', message: { role: 'user', content: '发送钉钉消息：起来吧' } }),
        JSON.stringify({ type: 'message', message: { role: 'assistant', content: '发送给谁？' } }),
        JSON.stringify({ type: 'message', message: { role: 'assistant', content: '起来吧' } }),
      ].join('\n'),
      'utf8',
    );

    registerExternalCronDeliveryPending({
      jobId: 'job-dingtalk',
      runSessionId: 'run-1',
      sessionKey: 'agent:main:scheduled-task:job-dingtalk:run-1',
      runId: 'run-dingtalk',
      agentId: 'main',
      taskMessage: '发送钉钉消息：起来吧',
      deliveryContext: {
        channel: 'dingtalk',
        to: '11427193',
      },
      registeredAtMs: Date.now(),
    });

    const rpc = vi.fn(async () => ({}));
    await handleExternalCronChatTerminal({
      rpc,
      runId: 'run-dingtalk',
      sessionKey: 'agent:main:scheduled-task:job-dingtalk:run-1',
      state: 'final',
      message: { role: 'assistant', content: '发送给谁？' },
    });

    expect(rpc).toHaveBeenCalledWith('send', expect.objectContaining({
      message: '起来吧',
    }), 60_000);
  });
});
