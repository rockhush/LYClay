import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const testOpenClawConfigDir = join(tmpdir(), 'clawx-tests', 'session-delivery-context');

vi.mock('../../electron/utils/paths', () => ({
  getOpenClawConfigDir: () => testOpenClawConfigDir,
}));

import {
  buildChannelMessageTargetSystemPrompt,
  inferDeliveryContextFromSessionKey,
  resolveSessionDeliveryContext,
} from '../../electron/utils/session-delivery-context';
import { enrichChatSendParams } from '../../electron/utils/chat-send-enrichment';

describe('session delivery context', () => {
  beforeEach(() => {
    mkdirSync(join(testOpenClawConfigDir, 'agents', 'main', 'sessions'), { recursive: true });
  });

  it('infers dingtalk delivery context from session key when sessions.json is missing', async () => {
    await expect(
      resolveSessionDeliveryContext('agent:main:dingtalk:cidDeVGroup='),
    ).resolves.toEqual({
      channel: 'dingtalk',
      to: 'cidDeVGroup=',
    });
  });

  it('prefers deliveryContext.to from sessions.json over session key suffix', async () => {
    writeFileSync(
      join(testOpenClawConfigDir, 'agents', 'main', 'sessions', 'sessions.json'),
      JSON.stringify({
        'agent:main:dingtalk:cid-group': {
          deliveryContext: {
            channel: 'dingtalk',
            accountId: 'default',
            to: 'cidResolvedTarget=',
          },
        },
      }),
      'utf8',
    );

    await expect(
      resolveSessionDeliveryContext('agent:main:dingtalk:cid-group'),
    ).resolves.toEqual({
      channel: 'dingtalk',
      to: 'cidResolvedTarget=',
      accountId: 'default',
    });
  });

  it('builds message-tool guidance that forbids target=self', () => {
    const prompt = buildChannelMessageTargetSystemPrompt({
      channel: 'dingtalk',
      to: 'cidResolvedTarget=',
      accountId: 'default',
    });

    expect(prompt).toContain('target="cidResolvedTarget="');
    expect(prompt).toContain('channel="dingtalk"');
    expect(prompt).toContain('NEVER use target="self"');
  });

  it('enriches chat.send params with channel delivery prompt', async () => {
    mkdirSync(join(testOpenClawConfigDir, 'agents', 'main', 'sessions'), { recursive: true });
    writeFileSync(
      join(testOpenClawConfigDir, 'agents', 'main', 'sessions', 'sessions.json'),
      JSON.stringify({
        'agent:main:dingtalk:cid-group': {
          deliveryContext: {
            channel: 'dingtalk',
            accountId: 'default',
            to: 'cidResolvedTarget=',
          },
        },
      }),
      'utf8',
    );

    const enriched = await enrichChatSendParams({
      sessionKey: 'agent:main:dingtalk:cid-group',
      message: 'send image',
      extraSystemPrompt: 'existing prompt',
    }) as Record<string, unknown>;

    expect(enriched.extraSystemPrompt).toContain('target="cidResolvedTarget="');
    expect(enriched.extraSystemPrompt).toContain('existing prompt');
    expect(enriched.message).toBe('send image');
  });

  it('preserves one-turn skillFilter while enriching delivery context', async () => {
    const enriched = await enrichChatSendParams({
      sessionKey: 'agent:main:dingtalk:cid-group',
      message: '@PPT生成 请使用这个技能，帮我',
      skillFilter: ['PPT生成'],
    }) as Record<string, unknown>;

    expect(enriched.skillFilter).toEqual(['PPT生成']);
    expect(enriched.extraSystemPrompt).toContain('target="cidResolvedTarget="');
  });

  it('does not infer delivery context for plain main sessions', () => {
    expect(inferDeliveryContextFromSessionKey('agent:main:main')).toBeNull();
  });
});
