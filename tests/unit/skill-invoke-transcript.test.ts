import { describe, expect, it } from 'vitest';
import {
  extractSkillInvocationFromToolCall,
  extractSkillSlugFromSkillMdPath,
  parseSkillReadsFromTranscript,
} from '../../shared/reporting/skill-invoke-transcript';

describe('skill-invoke-transcript', () => {
  it('extracts slug from openclaw skill paths', () => {
    expect(extractSkillSlugFromSkillMdPath('~/.openclaw/skills/pptx/SKILL.md')).toBe('pptx');
    expect(extractSkillSlugFromSkillMdPath('C:\\Users\\me\\.openclaw\\skills\\pdf\\SKILL.md')).toBe('pdf');
  });

  it('maps read SKILL.md tool calls back to skill slug', () => {
    expect(extractSkillInvocationFromToolCall('read', {
      path: 'C:\\Users\\me\\.openclaw\\skills\\docx\\SKILL.md',
    })).toEqual({
      skillId: 'docx',
      skillPath: 'C:\\Users\\me\\.openclaw\\skills\\docx\\SKILL.md',
    });
  });

  it('parses assistant read tool calls from transcript lines after turn start', () => {
    const userTs = 1_700_000_000_000;
    const assistantTs = userTs + 3_000;
    const transcript = [
      {
        type: 'message',
        timestamp: new Date(userTs).toISOString(),
        message: {
          role: 'user',
          content: 'Generate report',
          timestamp: userTs / 1000,
        },
      },
      {
        type: 'message',
        timestamp: new Date(assistantTs).toISOString(),
        message: {
          role: 'assistant',
          timestamp: assistantTs / 1000,
          content: [
            {
              type: 'tool_use',
              id: 'call-docx',
              name: 'read',
              input: { path: '~/.openclaw/skills/docx/SKILL.md' },
            },
          ],
        },
      },
    ].map((line) => JSON.stringify(line)).join('\n');

    const reads = parseSkillReadsFromTranscript(transcript, { afterMs: userTs });
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({
      skillId: 'docx',
      toolCallId: 'call-docx',
      invokeTimeMs: assistantTs,
    });
  });

  it('dedupes repeated reads of the same skill in one turn', () => {
    const userTs = 1_700_000_000_000;
    const transcript = [
      {
        type: 'message',
        message: { role: 'user', content: 'go', timestamp: userTs / 1000 },
      },
      {
        type: 'message',
        message: {
          role: 'assistant',
          timestamp: (userTs + 1_000) / 1000,
          content: [
            { type: 'tool_use', id: 'a', name: 'read', input: { path: '~/.openclaw/skills/pptx/SKILL.md' } },
          ],
        },
      },
      {
        type: 'message',
        message: {
          role: 'assistant',
          timestamp: (userTs + 2_000) / 1000,
          content: [
            { type: 'tool_use', id: 'b', name: 'read', input: { path: '~/.openclaw/skills/pptx/SKILL.md' } },
          ],
        },
      },
    ].map((line) => JSON.stringify(line)).join('\n');

    expect(parseSkillReadsFromTranscript(transcript, { afterMs: userTs })).toHaveLength(1);
  });
});
