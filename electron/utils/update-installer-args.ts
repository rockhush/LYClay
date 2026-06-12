export interface UpdateInstallerArgsOptions {
  /** NSIS silent mode (/S). Avoid on Windows when AV may block DLL replacement without user visibility. */
  silent?: boolean;
}

/** CLI args for electron-builder NSIS auto-update installs. */
export function buildUpdateInstallerArgs(
  platform: NodeJS.Platform = process.platform,
  options: UpdateInstallerArgsOptions = {},
): string[] {
  const args = ['--updated'];
  if (platform === 'win32' && options.silent) {
    args.unshift('/S');
  }
  return args;
}
