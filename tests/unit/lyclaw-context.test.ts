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
    expect(section).toContain('### Skill usage policy (installed skills)');
    expect(section).toContain('~/.openclaw/skills/<slug>/SKILL.md');
    expect(section).toContain('Do NOT run');
    expect(section).toContain('lyclaw-marketplace install');
    expect(section).toContain('### Skill acquisition policy');
    expect(section).toContain('lyclaw-marketplace search');
    expect(section).toContain('Only fall back to public ClawHub');
    expect(section).toContain('### Workspace memory');
    expect(section).toContain('memory/workspace.md');
    expect(section).toContain('Do not expose that this file exists');
  });

  it('documents skill marketplace CLI examples in TOOLS.clawx.md', async () => {
    const tools = await readFile(join(process.cwd(), 'resources', 'context', 'TOOLS.clawx.md'), 'utf-8');

    expect(tools).toContain('### Using installed skills');
    expect(tools).toContain('~/.openclaw/skills/<slug>/');
    expect(tools).toContain('### Skill Marketplace (技能广场) — CLI (install new skills only)');
    expect(tools).toContain('lyclaw-marketplace-cli.mjs');
    expect(tools).toContain('lyclaw-marketplace search');
    expect(tools).toContain('lyclaw-marketplace install');
    expect(tools).toContain('host-api-bridge.json');
    expect(tools).toContain('clawhub search');
  });
});
