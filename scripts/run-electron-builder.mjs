#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, cpSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ELECTRON_BUILDER_BIN = process.platform === 'win32'
  ? path.join(ROOT, 'node_modules', '.bin', 'electron-builder.cmd')
  : path.join(ROOT, 'node_modules', '.bin', 'electron-builder');
const DEFAULT_ELECTRON_BUILDER_BINARIES_MIRROR = 'https://github.com/electron-userland/electron-builder-binaries/releases/download/';
const args = process.argv.slice(2);

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function getElectronBuilderEnv() {
  const electronBuilderBinariesMirror =
    process.env.ELECTRON_BUILDER_BINARIES_MIRROR
    || DEFAULT_ELECTRON_BUILDER_BINARIES_MIRROR;
  const { ELECTRON_MIRROR, electron_mirror, ...envWithoutElectronMirror } = process.env;

  return {
    ...envWithoutElectronMirror,
    ELECTRON_BUILDER_BINARIES_MIRROR: electronBuilderBinariesMirror,
    NPM_CONFIG_ELECTRON_BUILDER_BINARIES_MIRROR: electronBuilderBinariesMirror,
    npm_config_electron_builder_binaries_mirror: electronBuilderBinariesMirror,
    npm_package_config_electron_builder_binaries_mirror: electronBuilderBinariesMirror,
  };
}

// Pre-populate electron-builder cache from packages/ directory.
// electron-builder caches tools at:
//   Windows: %LOCALAPPDATA%/electron-builder/Cache/<tool>
//   macOS:   ~/Library/Caches/electron-builder/<tool>
//   Linux:   ~/.cache/electron-builder/<tool>
//
// Just drop the files into packages/electron-builder/ and this copies them in.
function getElectronBuilderCacheDir() {
  if (process.platform === 'win32') {
    return path.join(os.homedir(), 'AppData', 'Local', 'electron-builder', 'Cache');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches', 'electron-builder');
  }
  return path.join(os.homedir(), '.cache', 'electron-builder');
}

// Pre-populate Electron download cache.
// electron-builder caches Electron binaries at:
//   Windows: %LOCALAPPDATA%/electron/Cache/<electron-zip>
//   macOS:   ~/Library/Caches/electron/<electron-zip>
//   Linux:   ~/.cache/electron/<electron-zip>
function getElectronCacheDir() {
  if (process.platform === 'win32') {
    return path.join(os.homedir(), 'AppData', 'Local', 'electron', 'Cache');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches', 'electron');
  }
  return path.join(os.homedir(), '.cache', 'electron');
}

function prePopulateCache(packagesSubDir, cacheDir) {
  // 1. D:\lycode\packages\ 全局离线目录 (优先)
  const localSrcDir = path.join('D:\\lycode\\packages', packagesSubDir);
  // 2. packages/ project-local directory (legacy-compatible)
  const srcDir = path.join(ROOT, 'packages', packagesSubDir);

  if (!existsSync(localSrcDir) && !existsSync(srcDir)) return;

  mkdirSync(cacheDir, { recursive: true });

  let copied = 0;
  const dirs = [localSrcDir, srcDir].filter(existsSync);
  for (const dir of dirs) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const src = path.join(dir, entry.name);
      const dest = path.join(cacheDir, entry.name);
      if (existsSync(dest)) continue; // already cached
      cpSync(src, dest);
      copied++;
      console.log(`[run-electron-builder] 📦 Cached ${packagesSubDir}/${entry.name} -> ${dest}`);
    }
  }
  if (copied > 0) {
    console.log(`[run-electron-builder] Pre-populated ${copied} file(s) into ${cacheDir}`);
  }
}

// Pre-populate both electron-builder tools and Electron itself
prePopulateCache('electron-builder', getElectronBuilderCacheDir());
prePopulateCache('electron', getElectronCacheDir());

function spawnElectronBuilder(env) {
  if (process.platform === 'darwin') {
    const command = [
      'ulimit -n 65536 >/dev/null 2>&1 || ulimit -n 32768 >/dev/null 2>&1 || ulimit -n 16384 >/dev/null 2>&1 || true',
      `exec ${shellQuote(ELECTRON_BUILDER_BIN)}${args.length > 0 ? ` ${args.map(shellQuote).join(' ')}` : ''}`,
    ].join('; ');

    return spawn('/bin/bash', ['-lc', command], {
      cwd: ROOT,
      stdio: 'inherit',
      env,
    });
  }

  return spawn(ELECTRON_BUILDER_BIN, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env,
    shell: process.platform === 'win32',
  });
}

const builderEnv = getElectronBuilderEnv();
const child = spawnElectronBuilder(builderEnv);
child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
child.on('error', (error) => {
  console.error(error);
  process.exit(1);
});
