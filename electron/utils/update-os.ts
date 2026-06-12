/** Resolve the `os` query param for the internal installer check/download API. */
export function resolveUpdateOSParam(
  platform: NodeJS.Platform,
  arch: string,
): string {
  switch (platform) {
    case 'darwin':
      return arch === 'arm64' ? 'macos-arm' : 'macos-x64';
    case 'linux':
      return 'linux';
    case 'win32':
    default:
      return 'windows';
  }
}

/** Candidate `os` values to try when checking for updates. */
export function resolveUpdateOSCandidates(
  platform: NodeJS.Platform,
  arch: string,
): string[] {
  switch (platform) {
    case 'darwin':
      return [resolveUpdateOSParam(platform, arch)];
    case 'linux':
      return ['linux'];
    case 'win32':
    default:
      return ['windows', 'win'];
  }
}

export function resolveInstallerExtension(platform: NodeJS.Platform): string {
  if (platform === 'win32') return '.exe';
  if (platform === 'darwin') return '.dmg';
  return '.tar.gz';
}
