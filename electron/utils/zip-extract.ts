import * as fs from 'fs';
import * as path from 'path';
import { inflateRawSync } from 'zlib';

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
const gb18030Decoder = new TextDecoder('gb18030' as unknown as undefined);

type ZipEntry = {
  rawName: Buffer;
  name: string;
  isDirectory: boolean;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
};

function decodeZipEntryName(raw: Buffer, flags: number): string {
  if ((flags & 0x0800) !== 0) {
    return new TextDecoder('utf-8').decode(raw);
  }

  try {
    return utf8Decoder.decode(raw);
  } catch {
    return gb18030Decoder.decode(raw);
  }
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minSize = 22;
  const maxCommentSize = 0xffff;
  const start = Math.max(0, buffer.length - minSize - maxCommentSize);
  for (let offset = buffer.length - minSize; offset >= start; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error('Invalid ZIP: End of Central Directory record not found');
}

function readZipEntries(buffer: Buffer): ZipEntry[] {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectorySize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;
  const entries: ZipEntry[] = [];
  let offset = centralDirectoryOffset;

  for (let index = 0; index < totalEntries && offset < centralDirectoryEnd; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('Invalid ZIP: Central Directory entry is malformed');
    }

    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraFieldLength = buffer.readUInt16LE(offset + 30);
    const fileCommentLength = buffer.readUInt16LE(offset + 32);
    const externalFileAttributes = buffer.readUInt32LE(offset + 38);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const rawNameStart = offset + 46;
    const rawNameEnd = rawNameStart + fileNameLength;
    if (rawNameEnd > buffer.length) {
      throw new Error('Invalid ZIP: Central Directory entry name is truncated');
    }

    const rawName = buffer.subarray(rawNameStart, rawNameEnd);
    const name = decodeZipEntryName(rawName, flags).replace(/\\/g, '/');
    entries.push({
      rawName,
      name,
      isDirectory: name.endsWith('/') || name.endsWith('\\') || ((externalFileAttributes & 0x10) !== 0),
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });

    offset = rawNameEnd + extraFieldLength + fileCommentLength;
  }

  return entries;
}

function resolveExtractionPath(destDir: string, entryName: string): string {
  if (path.posix.isAbsolute(entryName) || /^[A-Za-z]:[\\/]/.test(entryName)) {
    throw new Error(`Unsafe absolute ZIP entry path: ${entryName}`);
  }

  const resolvedDest = path.resolve(destDir);
  const resolvedEntry = path.resolve(resolvedDest, ...entryName.split('/').filter(Boolean));
  if (resolvedEntry !== resolvedDest && !resolvedEntry.startsWith(`${resolvedDest}${path.sep}`)) {
    throw new Error(`Unsafe ZIP entry path escapes destination: ${entryName}`);
  }
  return resolvedEntry;
}

function readEntryData(buffer: Buffer, entry: ZipEntry): Buffer {
  const offset = entry.localHeaderOffset;
  if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== 0x04034b50) {
    throw new Error(`Invalid ZIP: Local header is missing for ${entry.name}`);
  }

  const fileNameLength = buffer.readUInt16LE(offset + 26);
  const extraFieldLength = buffer.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + fileNameLength + extraFieldLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buffer.length) {
    throw new Error(`Invalid ZIP: Data is truncated for ${entry.name}`);
  }

  const compressed = buffer.subarray(dataStart, dataEnd);
  if (entry.method === 0) return Buffer.from(compressed);
  if (entry.method === 8) {
    const inflated = inflateRawSync(compressed);
    if (inflated.length !== entry.uncompressedSize) {
      throw new Error(`Invalid ZIP: Uncompressed size mismatch for ${entry.name}`);
    }
    return inflated;
  }

  throw new Error(`Unsupported ZIP compression method ${entry.method} for ${entry.name}`);
}

export async function extractZipArchive(zipPath: string, destDir: string): Promise<void> {
  await fs.promises.mkdir(destDir, { recursive: true });

  const buffer = await fs.promises.readFile(zipPath);
  for (const entry of readZipEntries(buffer)) {
    if (!entry.name || entry.name.split('/').every((segment) => !segment)) continue;

    const targetPath = resolveExtractionPath(destDir, entry.name);
    if (entry.isDirectory) {
      await fs.promises.mkdir(targetPath, { recursive: true });
      continue;
    }

    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.promises.writeFile(targetPath, readEntryData(buffer, entry));
  }
}
