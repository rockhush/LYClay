import { describe, expect, it } from 'vitest';
import {
  extractPseudoToolCallsFromText,
  isPseudoToolOnlyText,
  stripPseudoToolXmlFromText,
} from '../../shared/chat/pseudo-tool-xml';

describe('pseudo-tool-xml', () => {
  it('extracts read tool calls from XML text blocks', () => {
    const text = '<read> <path>~/.openclaw/skills/AOI外观AI分析/SKILL.md</path> </read>';
    expect(extractPseudoToolCallsFromText(text)).toEqual([
      {
        name: 'read',
        input: { path: '~/.openclaw/skills/AOI外观AI分析/SKILL.md' },
      },
    ]);
  });

  it('strips pseudo tool XML from display text', () => {
    const text = '<read> <path>~/.openclaw/skills/pptx/SKILL.md</path> </read>';
    expect(stripPseudoToolXmlFromText(text)).toBe('');
    expect(isPseudoToolOnlyText(text)).toBe(true);
  });

  it('preserves markdown newlines when stripping pseudo tool XML', () => {
    const text = [
      '<read> <path>~/.openclaw/skills/cn-translate/SKILL.md</path> </read>',
      '',
      '## 主要功能',
      '- Key: 中文 → 英文 Key',
      '- Value: 中文 → 英文 Value',
    ].join('\n');
    expect(stripPseudoToolXmlFromText(text)).toBe([
      '## 主要功能',
      '- Key: 中文 → 英文 Key',
      '- Value: 中文 → 英文 Value',
    ].join('\n'));
    expect(isPseudoToolOnlyText(text)).toBe(false);
  });
});
