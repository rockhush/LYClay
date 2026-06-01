import { app } from 'electron';
import { spawn } from 'child_process';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';

/** Resolved path to the running .app bundle (e.g. /Applications/LYClaw.app). */
export function getMacAppBundlePath(): string {
  return path.resolve(path.dirname(app.getPath('exe')), '..', '..');
}

export function buildMacDmgInstallScript(options: {
  dmgPath: string;
  targetAppPath: string;
  mountPoint: string;
  scriptPath: string;
}): string {
  const { dmgPath, targetAppPath, mountPoint, scriptPath } = options;
  const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

  return `#!/bin/bash
set -euo pipefail
sleep 2
mkdir -p ${shellQuote(mountPoint)}
if ! hdiutil attach -nobrowse -quiet -mountpoint ${shellQuote(mountPoint)} ${shellQuote(dmgPath)}; then
  exit 1
fi
APP="$(find ${shellQuote(mountPoint)} -maxdepth 1 -name '*.app' | head -1)"
if [ -z "$APP" ]; then
  hdiutil detach ${shellQuote(mountPoint)} -quiet || true
  exit 1
fi
ditto "$APP" ${shellQuote(targetAppPath)}
hdiutil detach ${shellQuote(mountPoint)} -quiet || true
rm -rf ${shellQuote(mountPoint)}
open ${shellQuote(targetAppPath)}
rm -f ${shellQuote(scriptPath)}
`;
}

/**
 * Mount the downloaded DMG, replace the current app bundle, and relaunch.
 * Runs in a detached shell script so the main process can quit first.
 */
export async function launchMacDmgUpdateInstall(dmgPath: string): Promise<void> {
  const userData = app.getPath('userData');
  const mountPoint = path.join(userData, 'update-mount');
  const scriptPath = path.join(userData, `install-update-${Date.now()}.sh`);
  const targetAppPath = getMacAppBundlePath();
  const script = buildMacDmgInstallScript({
    dmgPath,
    targetAppPath,
    mountPoint,
    scriptPath,
  });

  await mkdir(userData, { recursive: true });
  await writeFile(scriptPath, script, { mode: 0o755 });

  await new Promise<void>((resolve, reject) => {
    const child = spawn('/bin/bash', [scriptPath], {
      detached: true,
      stdio: 'ignore',
    });

    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
