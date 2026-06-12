import { describe, expect, it } from 'vitest';
import {
  resolveInstallerExtension,
  resolveUpdateOSCandidates,
  resolveUpdateOSParam,
} from '@electron/utils/update-os';

describe('update-os', () => {
  it('maps mac arm64 to macos-arm', () => {
    expect(resolveUpdateOSParam('darwin', 'arm64')).toBe('macos-arm');
    expect(resolveUpdateOSCandidates('darwin', 'arm64')).toEqual(['macos-arm']);
  });

  it('maps mac x64 to macos-x64', () => {
    expect(resolveUpdateOSParam('darwin', 'x64')).toBe('macos-x64');
    expect(resolveUpdateOSCandidates('darwin', 'x64')).toEqual(['macos-x64']);
  });

  it('keeps windows candidates unchanged', () => {
    expect(resolveUpdateOSParam('win32', 'x64')).toBe('windows');
    expect(resolveUpdateOSCandidates('win32', 'x64')).toEqual(['windows', 'win']);
  });

  it('resolves installer extensions by platform', () => {
    expect(resolveInstallerExtension('win32')).toBe('.exe');
    expect(resolveInstallerExtension('darwin')).toBe('.dmg');
    expect(resolveInstallerExtension('linux')).toBe('.tar.gz');
  });
});
