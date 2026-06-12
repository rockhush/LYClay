import { describe, expect, it } from 'vitest';
import { parseReleaseNotes } from '@/lib/update-release-notes';

describe('parseReleaseNotes', () => {
  it('parses numbered changelog into a general section', () => {
    const notes = parseReleaseNotes('1. 修复 mac 更新检测\n2. 修复 Agent 弹窗');
    expect(notes).toHaveLength(1);
    expect(notes[0].key).toBe('general');
    expect(notes[0].items).toHaveLength(2);
    expect(notes[0].items[0].headline).toContain('mac');
  });

  it('splits 新功能 and 优化 sections', () => {
    const raw = `新功能：
1. 核心办公能力扩展：知识问答
优化：
1. 体验优化：加载更快`;
    const notes = parseReleaseNotes(raw);
    expect(notes).toHaveLength(2);
    expect(notes[0].key).toBe('features');
    expect(notes[1].key).toBe('optimizations');
    expect(notes[0].items[0].headline).toBe('核心办公能力扩展');
    expect(notes[0].items[0].detail).toContain('知识问答');
  });
});
