import { describe, expect, it } from 'vitest';
import { buildUpdateInstallerArgs } from '@electron/utils/update-installer-args';

describe('buildUpdateInstallerArgs', () => {
  it('passes updated flag on Windows without silent by default', () => {
    expect(buildUpdateInstallerArgs('win32')).toEqual(['--updated']);
  });

  it('passes NSIS silent + updated flags on Windows when requested', () => {
    expect(buildUpdateInstallerArgs('win32', { silent: true })).toEqual(['/S', '--updated']);
  });

  it('passes updated flag on macOS', () => {
    expect(buildUpdateInstallerArgs('darwin')).toEqual(['--updated']);
  });
});
