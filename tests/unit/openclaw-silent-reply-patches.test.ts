import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyOpenClawSilentReplyPatches,
  hasOpenClawSilentReplyPatches,
  SILENT_REPLY_PATCH_MARKER,
} from '../../scripts/openclaw-silent-reply-patches.mjs';
import {
  sanitizeTranscriptMessageForDisplay,
  stripSilentReplyToken,
} from '@electron/utils/silent-reply-sanitize';

describe('stripSilentReplyToken (electron)', () => {
  it('removes trailing NO_REPLY from substantive assistant text', () => {
    expect(stripSilentReplyToken('面试题库已生成。\n\nNO_REPLY')).toBe('面试题库已生成。');
  });

  it('returns empty string for silent-only replies', () => {
    expect(stripSilentReplyToken('NO_REPLY')).toBe('');
  });
});

describe('sanitizeTranscriptMessageForDisplay', () => {
  it('strips NO_REPLY suffix from assistant message content blocks', () => {
    const input = {
      role: 'assistant',
      content: [{ type: 'text', text: '报告完成。\n\nNO_REPLY' }],
    };
    const output = sanitizeTranscriptMessageForDisplay(input) as typeof input;
    expect(output.content[0].text).toBe('报告完成。');
  });

  it('leaves user messages unchanged', () => {
    const input = { role: 'user', content: 'NO_REPLY' };
    expect(sanitizeTranscriptMessageForDisplay(input)).toEqual(input);
  });
});

describe('applyOpenClawSilentReplyPatches', () => {
  it('patches selection bundle replay + persistence helpers', () => {
    const fixturePath = join(process.cwd(), 'tests', 'fixtures', 'openclaw-selection-replay-snippet.js');
    const source = readFileSync(fixturePath, 'utf8');
    expect(hasOpenClawSilentReplyPatches(source)).toBe(false);

    const result = applyOpenClawSilentReplyPatches(source);
    expect(result.patched).toBe(true);
    expect(hasOpenClawSilentReplyPatches(result.source)).toBe(true);
    expect(result.source).toContain(SILENT_REPLY_PATCH_MARKER);
    expect(result.source).toContain('sanitizeAssistantMessageForTranscriptPersistence');
    expect(result.source).toContain('let finalMessage = applyBeforeWriteHook(persistMessage(nextMessage));');
    expect(result.source).toContain('c as stripSilentToken');
    expect(result.source).not.toContain('if (!trimmed || isSilentReplyPayloadText(trimmed, "NO_REPLY")) return null;');
  });
});
