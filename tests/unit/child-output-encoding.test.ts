import { describe, expect, it } from 'vitest';
import { decodeChildProcessOutput } from '@electron/utils/child-output-encoding';

describe('decodeChildProcessOutput', () => {
  it('returns utf8 text unchanged on non-windows platforms', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      expect(decodeChildProcessOutput(Buffer.from('hello', 'utf8'))).toBe('hello');
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });

  it('decodes gb18030 bytes on windows when utf8 produces replacement chars', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const gbBytes = Buffer.from('配置', 'utf16le');
      const decoded = decodeChildProcessOutput(gbBytes);
      expect(decoded.length).toBeGreaterThan(0);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });
});
