import { describe, expect, it } from 'vitest';
import {
  collectAgentIdsFromSessionKeys,
  isBootstrapPendingPreview,
  isPlaceholderSessionTitle,
  isUntrustedGatewayMetadataPreview,
  sessionHasBootstrapPendingPreview,
  sessionHasUntrustedGatewayMetadataPreview,
  resolveSessionDisplayLabel,
} from '../../src/lib/session-label-utils';

describe('session label utils', () => {
  it('treats LYClaw as a placeholder session title', () => {
    expect(isPlaceholderSessionTitle('LYClaw')).toBe(true);
    expect(isPlaceholderSessionTitle('LYClaw UI')).toBe(true);
    expect(isPlaceholderSessionTitle('@翻译工具 足球 篮球')).toBe(false);
  });

  it('prefers first user preview over LYClaw displayName', () => {
    expect(resolveSessionDisplayLabel({
      sessionKey: 'agent:buyer:session-1',
      firstUserMessagePreview: '@翻译工具 足球 篮球',
      label: 'LYClaw',
      displayName: 'LYClaw',
    })).toBe('@翻译工具 足球 篮球');
  });

  it('rewrites runtime skill mentions in session previews', () => {
    expect(resolveSessionDisplayLabel({
      sessionKey: 'agent:main:session-1',
      firstUserMessagePreview: '@commodity-dingtalk-pusher 请使用这个技能，帮我看看',
      skills: [{
        id: 'commodity-dingtalk-pusher',
        slug: 'commodity-dingtalk-pusher',
        name: '大宗行情钉钉群简报',
      }],
    })).toBe('@大宗行情钉钉群简报 请使用这个技能，帮我看看');
  });

  it('detects untrusted Gateway metadata previews', () => {
    expect(isUntrustedGatewayMetadataPreview('Sender (untrusted metadata): ```json')).toBe(true);
    expect(isUntrustedGatewayMetadataPreview('Conversation info (untrusted metadata): {')).toBe(true);
    expect(isUntrustedGatewayMetadataPreview('你好')).toBe(false);
    expect(sessionHasUntrustedGatewayMetadataPreview({
      firstUserMessagePreview: 'Sender (untrusted metadata)...',
    })).toBe(true);
  });

  it('detects bootstrap pending previews', () => {
    expect(isBootstrapPendingPreview('[Bootstrap pending] Please read BOOTSTRAP.md')).toBe(true);
    expect(isBootstrapPendingPreview('提醒项目负责人填写日报')).toBe(false);
    expect(sessionHasBootstrapPendingPreview({
      firstUserMessagePreview: '[Bootstrap pending] Please r...',
    })).toBe(true);
  });

  it('collects agent ids from session keys', () => {
    expect(collectAgentIdsFromSessionKeys([
      'agent:main:session-1',
      'agent:buyer:session-2',
      'agent:docs:session-3',
    ])).toEqual(['main', 'buyer', 'docs']);
  });
});
