import { describe, expect, it } from 'vitest';
import {
  buildStagedDiskFileName,
  buildStagedMediaSystemPrompt,
  displayNameFromStagedDiskFileName,
  extractMediaAttachedRefs,
  preferAuthoritativeMediaRefs,
} from '../../shared/media-staging';

describe('buildStagedDiskFileName', () => {
  it('embeds original basename after staging uuid', () => {
    const id = '7018aa87-7e25-4b26-92f3-86eead654066';
    const disk = buildStagedDiskFileName(id, '中南大学---screenshot.png');
    expect(disk).toBe(`${id}-中南大学---screenshot.png`);
    expect(displayNameFromStagedDiskFileName(disk)).toBe('中南大学---screenshot.png');
  });

  it('sanitizes illegal path characters in the original name', () => {
    const disk = buildStagedDiskFileName('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'bad:name?.png');
    expect(disk).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee-bad_name_.png');
  });
});

describe('extractMediaAttachedRefs', () => {
  it('parses paths with spaces and mime annotations', () => {
    const outbound = 'C:\\Users\\me\\.openclaw\\media\\outbound\\7018aa87-7e25-4b26-92f3-86eead654066.png';
    const text = [
      'send this',
      `[media attached: ${outbound} (image/png) | ${outbound}]`,
    ].join('\n');
    const refs = extractMediaAttachedRefs(text);
    expect(refs).toHaveLength(1);
    expect(refs[0].mimeType).toBe('image/png');
    expect(refs[0].filePath).toBe(outbound);
  });

  it('parses distinct left and right paths in one block', () => {
    const inbound = 'media://inbound/中南大学---8ac81790-ccfb-41a1-83c7-d98819166033.png';
    const outbound = 'C:\\Users\\me\\.openclaw\\media\\outbound\\7018aa87-7e25-4b26-92f3-86eead654066.png';
    const text = `[media attached: ${inbound} (image/png) | ${outbound}]`;
    const refs = extractMediaAttachedRefs(text);
    expect(refs).toHaveLength(2);
    expect(refs[0].filePath).toBe(inbound);
    expect(refs[1].filePath).toBe(outbound);
  });

  it('prefers outbound disk paths over media:// inbound URIs', () => {
    const text = [
      '[media attached: media://inbound/中南大学---8ac81790-ccfb-41a1-83c7-d98819166033.png (image/png)]',
      '[media attached: C:\\Users\\me\\.openclaw\\media\\outbound\\7018aa87-7e25-4b26-92f3-86eead654066-中南大学---screenshot.png (image/png) | C:\\Users\\me\\.openclaw\\media\\outbound\\7018aa87-7e25-4b26-92f3-86eead654066-中南大学---screenshot.png]',
    ].join('\n');
    const refs = preferAuthoritativeMediaRefs(extractMediaAttachedRefs(text));
    expect(refs).toHaveLength(1);
    expect(refs[0].filePath).toContain('outbound');
    expect(refs[0].filePath).not.toMatch(/^media:\/\//);
  });
});

describe('buildStagedMediaSystemPrompt', () => {
  it('lists exact staged paths for the model', () => {
    const prompt = buildStagedMediaSystemPrompt([{
      filePath: 'C:\\out\\uuid-file.png',
      fileName: 'file.png',
      mimeType: 'image/png',
    }]);
    expect(prompt).toContain('C:\\out\\uuid-file.png');
    expect(prompt).toContain('Do not merge UUIDs');
  });
});
