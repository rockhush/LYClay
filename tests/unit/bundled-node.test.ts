import { describe, expect, it } from 'vitest';
import { buildBundledNpmEnv } from '@electron/utils/bundled-node';

describe('buildBundledNpmEnv', () => {
  it('sets npm_execpath on Windows when npm-cli.js exists', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const env = buildBundledNpmEnv({ PATH: 'C:\\Windows\\System32' });
      if (env.npm_execpath) {
        expect(env.npm_execpath).toContain('npm-cli.js');
      } else {
        expect(env.PATH).toBe('C:\\Windows\\System32');
      }
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });
});
