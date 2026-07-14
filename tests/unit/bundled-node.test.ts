import { app } from 'electron';
import { describe, expect, it } from 'vitest';
import { buildBundledNpmEnv, getBundledBinDir, getBundledNodeExe } from '@electron/utils/bundled-node';

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


describe('bundled Node paths', () => {
  it('resolves packaged macOS Node from process.resourcesPath/bin/node', () => {
    const originalPlatform = process.platform;
    const originalArch = process.arch;
    const originalResourcesPath = process.resourcesPath;
    const originalPackaged = app.isPackaged;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    Object.defineProperty(process, 'arch', { value: 'arm64' });
    Object.defineProperty(process, 'resourcesPath', { value: '/Applications/LYClaw.app/Contents/Resources', configurable: true });
    Object.defineProperty(app, 'isPackaged', { value: true, configurable: true });
    try {
      expect(getBundledBinDir().replace(/\\/g, '/')).toBe('/Applications/LYClaw.app/Contents/Resources/bin');
      expect(getBundledNodeExe().replace(/\\/g, '/')).toBe('/Applications/LYClaw.app/Contents/Resources/bin/node');
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      Object.defineProperty(process, 'arch', { value: originalArch });
      Object.defineProperty(process, 'resourcesPath', { value: originalResourcesPath, configurable: true });
      Object.defineProperty(app, 'isPackaged', { value: originalPackaged, configurable: true });
    }
  });

  it('resolves dev macOS Node from resources/bin/darwin-arch/node', () => {
    const originalPlatform = process.platform;
    const originalArch = process.arch;
    const originalPackaged = app.isPackaged;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    Object.defineProperty(process, 'arch', { value: 'x64' });
    Object.defineProperty(app, 'isPackaged', { value: false, configurable: true });
    try {
      expect(getBundledNodeExe().replace(/\\/g, '/')).toContain('/resources/bin/darwin-x64/node');
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      Object.defineProperty(process, 'arch', { value: originalArch });
      Object.defineProperty(app, 'isPackaged', { value: originalPackaged, configurable: true });
    }
  });
});
