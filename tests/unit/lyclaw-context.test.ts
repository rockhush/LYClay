import { readFile } from 'fs/promises';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

describe('LYClaw context snippets', () => {
  it('guides the agent to answer simple questions before using tools', async () => {
    const section = await readFile(join(process.cwd(), 'resources', 'context', 'AGENTS.clawx.md'), 'utf-8');

    expect(section).toContain('### Fast-answer policy');
    expect(section).toContain('answer directly first');
    expect(section).toContain('memory_search');
    expect(section).toContain('DingTalk');
    expect(section).toContain('public vendor help pages');
  });
});
