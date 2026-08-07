import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeTextBuffer, readJsonFile, readJsonFileSync, readTextFile, readTextFileSync } from '../../electron/utils/text-file-encoding';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// '中文' in various encodings (exact byte sequences)
const UTF8_BYTES = Buffer.from('中文', 'utf-8'); // E4 B8 AD E6 96 87
const UTF8_BOM = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), UTF8_BYTES]);
const UTF16LE_BOM = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文', 'utf-16le')]);
const UTF16BE_BOM = Buffer.from([0xfe, 0xff, 0x4e, 0x2d, 0x65, 0x87]); // '中文' UTF-16BE + BOM
const GB18030_BYTES = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]); // '中文' in GB18030/CP936
const ASCII = Buffer.from('{"k":"v"}', 'utf-8');

describe('decodeTextBuffer', () => {
  it('decodes UTF-8 without BOM', () => {
    expect(decodeTextBuffer(UTF8_BYTES)).toBe('中文');
  });

  it('decodes UTF-8 with BOM and strips the BOM', () => {
    const out = decodeTextBuffer(UTF8_BOM);
    expect(out).toBe('中文');
    expect(out.charCodeAt(0)).not.toBe(0xfeff);
  });

  it('decodes UTF-16LE with BOM (PowerShell redirect output)', () => {
    expect(decodeTextBuffer(UTF16LE_BOM)).toBe('中文');
  });

  it('decodes UTF-16BE with BOM', () => {
    expect(decodeTextBuffer(UTF16BE_BOM)).toBe('中文');
  });

  it('falls back to GB18030 for CP936 bytes without BOM', () => {
    expect(decodeTextBuffer(GB18030_BYTES)).toBe('中文');
  });

  it('decodes plain ASCII/UTF-8 JSON', () => {
    expect(decodeTextBuffer(ASCII)).toBe('{"k":"v"}');
  });

  it('returns empty string for empty buffer', () => {
    expect(decodeTextBuffer(Buffer.alloc(0))).toBe('');
  });
});

describe('readTextFile / readTextFileSync', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tfe-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads UTF-16LE BOM file correctly (async + sync)', async () => {
    const p = join(dir, 'a.json');
    writeFileSync(p, UTF16LE_BOM);
    expect(await readTextFile(p)).toBe('中文');
    expect(readTextFileSync(p)).toBe('中文');
  });

  it('reads UTF-8 BOM file without leaving BOM char', async () => {
    const p = join(dir, 'b.txt');
    writeFileSync(p, UTF8_BOM);
    const out = await readTextFile(p);
    expect(out).toBe('中文');
    expect(out.charCodeAt(0)).not.toBe(0xfeff);
  });

  it('reads GB18030 file', async () => {
    const p = join(dir, 'c.txt');
    writeFileSync(p, GB18030_BYTES);
    expect(await readTextFile(p)).toBe('中文');
  });
});

describe('readJsonFile / readJsonFileSync', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tfej-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('parses JSON from a UTF-16LE BOM file', async () => {
    const p = join(dir, 'data.json');
    writeFileSync(p, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('{"name":"中文"}', 'utf-16le')]));
    await expect(readJsonFile(p)).resolves.toEqual({ name: '中文' });
    expect(readJsonFileSync(p)).toEqual({ name: '中文' });
  });

  it('parses JSON from a UTF-8 BOM file', async () => {
    const p = join(dir, 'data2.json');
    writeFileSync(p, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"name":"中文"}', 'utf-8')]));
    expect(readJsonFileSync(p)).toEqual({ name: '中文' });
  });
});
