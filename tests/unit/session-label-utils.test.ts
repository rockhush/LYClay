import { describe, expect, it } from 'vitest';
import {
  collectAgentIdsFromSessionKeys,
  isPlaceholderSessionTitle,
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

  it('collects agent ids from session keys', () => {
    expect(collectAgentIdsFromSessionKeys([
      'agent:main:session-1',
      'agent:buyer:session-2',
      'agent:docs:session-3',
    ])).toEqual(['main', 'buyer', 'docs']);
  });
});
