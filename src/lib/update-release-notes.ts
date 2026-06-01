export type ReleaseNoteSectionKey = 'features' | 'optimizations' | 'general';

export interface ReleaseNoteSection {
  key: ReleaseNoteSectionKey;
  title: string;
  items: Array<{ headline: string; detail?: string }>;
}

const SECTION_HEADERS: Array<{ key: ReleaseNoteSectionKey; pattern: RegExp }> = [
  { key: 'features', pattern: /^新功能\s*[:：]?\s*$/i },
  { key: 'optimizations', pattern: /^优化\s*[:：]?\s*$/i },
];

function parseBulletLine(line: string): { headline: string; detail?: string } {
  const cleaned = line
    .replace(/^[\d]+[.、)\]]\s*/, '')
    .replace(/^[-*•]\s*/, '')
    .trim();
  if (!cleaned) {
    return { headline: '' };
  }

  const colonIndex = cleaned.search(/[:：]/);
  if (colonIndex > 0 && colonIndex < cleaned.length - 1) {
    return {
      headline: cleaned.slice(0, colonIndex).trim(),
      detail: cleaned.slice(colonIndex + 1).trim(),
    };
  }

  return { headline: cleaned };
}

function splitItems(block: string): Array<{ headline: string; detail?: string }> {
  return block
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseBulletLine)
    .filter((item) => item.headline.length > 0);
}

/**
 * Parse changelog text from the update API into display sections.
 * Supports optional "新功能" / "优化" headings; otherwise returns one general block.
 */
export function parseReleaseNotes(raw: string | null | undefined): ReleaseNoteSection[] {
  const text = (raw || '').trim();
  if (!text) return [];

  const lines = text.split(/\r?\n/);
  const sections: ReleaseNoteSection[] = [];
  let currentKey: ReleaseNoteSectionKey = 'general';
  let currentTitle = '';
  let buffer: string[] = [];

  const flush = () => {
    const block = buffer.join('\n').trim();
    if (!block) return;
    const items = splitItems(block);
    if (items.length === 0) return;
    sections.push({
      key: currentKey,
      title: currentTitle,
      items,
    });
    buffer = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^更新内容\s*[:：]?\s*$/i.test(trimmed)) {
      continue;
    }
    const header = SECTION_HEADERS.find((entry) => entry.pattern.test(trimmed));
    if (header) {
      flush();
      currentKey = header.key;
      currentTitle = trimmed.replace(/[:：]\s*$/, '');
      continue;
    }
    buffer.push(line);
  }

  flush();

  if (sections.length > 0) {
    return sections;
  }

  const items = splitItems(text);
  if (items.length === 0) return [];

  return [{ key: 'general', title: '', items }];
}
