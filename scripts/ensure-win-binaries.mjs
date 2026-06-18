#!/usr/bin/env node

import { existsSync } from 'node:fs';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = `${process.platform}-${process.arch}`;
const bundledNpmCli = path.join(ROOT_DIR, 'resources', 'bin', target, 'node_modules', 'npm', 'bin', 'npm-cli.js');

function npmCliFromNodeExe(nodeExe) {
  return path.join(path.dirname(nodeExe), 'node_modules', 'npm', 'bin', 'npm-cli.js');
}

function hasSystemNpmCli() {
  if (process.platform !== 'win32') return false;

  if (existsSync(npmCliFromNodeExe(process.execPath))) {
    return true;
  }

  try {
    const whereOutput = execSync('where.exe node', {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    for (const line of whereOutput.split(/\r?\n/)) {
      const nodePath = line.trim();
      if (!nodePath) continue;
      if (existsSync(npmCliFromNodeExe(nodePath))) {
        return true;
      }
    }
  } catch {
    // ignore
  }
  return false;
}

if (process.platform !== 'win32') {
  process.exit(0);
}

if (existsSync(bundledNpmCli)) {
  console.log(`[ensure-win-binaries] npm-cli.js already present at resources/bin/${target}`);
  process.exit(0);
}

if (hasSystemNpmCli()) {
  console.log('[ensure-win-binaries] Bundled npm-cli.js missing, but system Node/npm is available — skipping download.');
  process.exit(0);
}

console.log('[ensure-win-binaries] Downloading bundled Node.js for gateway (current arch only)...');

function spawnDownloadScript() {
  const scriptPath = path.join(ROOT_DIR, 'scripts', 'download-bundled-node.mjs');
  const zxCmd = path.join(ROOT_DIR, 'node_modules', '.bin', 'zx.cmd');
  const zxBin = path.join(ROOT_DIR, 'node_modules', '.bin', 'zx');

  if (existsSync(zxCmd) || existsSync(zxBin)) {
    const zxExecutable = existsSync(zxCmd) ? zxCmd : zxBin;
    return spawnSync(zxExecutable, [scriptPath], {
      cwd: ROOT_DIR,
      env: process.env,
      stdio: 'inherit',
      shell: true,
      windowsHide: true,
    });
  }

  return spawnSync('pnpm', ['exec', 'zx', scriptPath], {
    cwd: ROOT_DIR,
    env: process.env,
    stdio: 'inherit',
    shell: true,
    windowsHide: true,
  });
}

const result = spawnDownloadScript();

if (result.status !== 0 || !existsSync(bundledNpmCli)) {
  console.error(
    '[ensure-win-binaries] Failed to install bundled npm-cli.js. ' +
    'Try: pnpm run node:download:win:local',
  );
  process.exit(result.status ?? 1);
}

console.log('[ensure-win-binaries] Gateway npm runtime ready.');
