import { readFileSync } from 'fs';
import * as fsP from 'fs/promises';

/**
 * Decode a raw byte buffer into a string, auto-detecting the encoding from the
 * BOM and falling back to UTF-8 / GB18030. This is the single entry point for
 * reading text files that may have been written by PowerShell redirects on
 * Windows (which default to UTF-16LE with BOM) or by legacy CP936/GB18030
 * tooling, so downstream UTF-8 consumers (e.g. JSON.parse) do not break.
 *
 * Detection order:
 *   1. UTF-16LE BOM (FF FE)  -> decode as utf-16le (BOM stripped)
 *   2. UTF-16BE BOM (FE FF)  -> decode as utf-16be (BOM stripped)
 *   3. UTF-8 BOM (EF BB BF)  -> decode as utf-8   (BOM stripped)
 *   4. No BOM                -> strict UTF-8, on failure fall back to GB18030
 */
export function decodeTextBuffer(buf: Buffer): string {
  if (buf.length === 0) return '';

  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return safeDecode(buf.subarray(2), 'utf-16le');
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return safeDecode(buf.subarray(2), 'utf-16be');
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return safeDecode(buf.subarray(3), 'utf-8');
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('gb18030').decode(buf);
    } catch {
      return buf.toString('utf-8');
    }
  }
}

function safeDecode(buf: Buffer, label: string): string {
  try {
    return new TextDecoder(label).decode(buf);
  } catch {
    return buf.toString('utf-8');
  }
}

export async function readTextFile(path: string): Promise<string> {
  return decodeTextBuffer(await fsP.readFile(path));
}

export function readTextFileSync(path: string): string {
  return decodeTextBuffer(readFileSync(path));
}

export async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readTextFile(path));
}

export function readJsonFileSync(path: string): unknown {
  return JSON.parse(readTextFileSync(path));
}
