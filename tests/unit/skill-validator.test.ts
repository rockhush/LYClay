import { describe, expect, it } from 'vitest';
import {
  checkFileExtension,
  validateZipStructure,
  type ZipEntryInfo,
} from '../../electron/utils/skill-validator';

function fileEntry(entryName: string): ZipEntryInfo {
  return {
    entryName,
    isDirectory: false,
    uncompressedSize: 128,
    compressedSize: 64,
  };
}

describe('skill ZIP file type validation', () => {
  it.each(['module.pyc', 'module.pyo'])('treats Python bytecode %s as a warning', (entryName) => {
    expect(checkFileExtension(entryName)).toEqual({
      level: 'warning',
      message: `Potentially dangerous script file: "${entryName}" (extension .${entryName.split('.').pop()})`,
    });

    const result = validateZipStructure([fileEntry(entryName)]);
    expect(result.allowed).toBe(true);
    expect(result.summary).toEqual({ errors: 0, warnings: 1 });
  });

  it.each(['tool.exe', 'library.dll', 'setup.bat'])('continues blocking executable file %s', (entryName) => {
    const result = validateZipStructure([fileEntry(entryName)]);

    expect(result.allowed).toBe(false);
    expect(result.findings).toContainEqual(expect.objectContaining({
      level: 'error',
      category: 'file-type',
    }));
  });
});
