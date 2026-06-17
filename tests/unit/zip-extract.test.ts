import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { extractZipArchive } from '../../electron/utils/zip-extract';

function encodeMinimalGb18030(value: string): Buffer {
  const bytes: number[] = [];
  for (const char of value) {
    if (char === '\u5c01') {
      bytes.push(0xb7, 0xe2);
    } else if (char === '\u9762') {
      bytes.push(0xc3, 0xe6);
    } else {
      const code = char.charCodeAt(0);
      if (code > 0x7f) throw new Error(`Unexpected non-ASCII test character: ${char}`);
      bytes.push(code);
    }
  }
  return Buffer.from(bytes);
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function writeStoredZip(zipPath: string, entries: Array<{ rawName: Buffer; content: Buffer }>): Promise<void> {
  const chunks: Buffer[] = [];
  const centralDirectory: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const checksum = crc32(entry.content);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(entry.content.length, 18);
    localHeader.writeUInt32LE(entry.content.length, 22);
    localHeader.writeUInt16LE(entry.rawName.length, 26);
    chunks.push(localHeader, entry.rawName, entry.content);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(entry.content.length, 20);
    centralHeader.writeUInt32LE(entry.content.length, 24);
    centralHeader.writeUInt16LE(entry.rawName.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    centralDirectory.push(centralHeader, entry.rawName);

    offset += localHeader.length + entry.rawName.length + entry.content.length;
  }

  const centralDirectorySize = centralDirectory.reduce((size, chunk) => size + chunk.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectorySize, 12);
  eocd.writeUInt32LE(offset, 16);

  await fs.promises.writeFile(zipPath, Buffer.concat([...chunks, ...centralDirectory, eocd]));
}

describe('extractZipArchive', () => {
  it('extracts ZIP entries whose names are encoded as GB18030 without UTF-8 flags', async () => {
    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'clawx-zip-extract-'));
    const zipPath = path.join(tempRoot, 'skill.zip');
    const destDir = path.join(tempRoot, 'extract');

    try {
      await writeStoredZip(zipPath, [
        {
          rawName: encodeMinimalGb18030('ppt-master/templates/layouts/\u5c01\u9762/02_toc.svg'),
          content: Buffer.from('<svg />', 'utf8'),
        },
      ]);

      await extractZipArchive(zipPath, destDir);

      await expect(
        fs.promises.readFile(
          path.join(destDir, 'ppt-master', 'templates', 'layouts', '\u5c01\u9762', '02_toc.svg'),
          'utf8',
        ),
      ).resolves.toBe('<svg />');
    } finally {
      await fs.promises.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('blocks ZIP entries that escape the extraction directory', async () => {
    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'clawx-zip-extract-'));
    const zipPath = path.join(tempRoot, 'evil.zip');
    const destDir = path.join(tempRoot, 'extract');

    try {
      await writeStoredZip(zipPath, [
        { rawName: Buffer.from('../evil.txt', 'utf8'), content: Buffer.from('nope', 'utf8') },
      ]);

      await expect(extractZipArchive(zipPath, destDir)).rejects.toThrow('escapes destination');
      await expect(fs.promises.access(path.join(tempRoot, 'evil.txt'))).rejects.toThrow();
    } finally {
      await fs.promises.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
