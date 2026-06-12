import { app } from 'electron';
import { execSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { logger } from './logger';

export function getBundledBinDir(): string {
  const target = `${process.platform}-${process.arch}`;
  return app.isPackaged
    ? path.join(process.resourcesPath, 'bin')
    : path.join(process.cwd(), 'resources', 'bin', target);
}

export function getBundledNodeExe(): string {
  const binDir = getBundledBinDir();
  return process.platform === 'win32'
    ? path.join(binDir, 'node.exe')
    : path.join(binDir, 'node');
}

export function getBundledNpmCliPath(): string {
  return path.join(getBundledBinDir(), 'node_modules', 'npm', 'bin', 'npm-cli.js');
}

function isValidNpmCliPath(candidate: string | undefined): candidate is string {
  return Boolean(candidate && existsSync(candidate) && candidate.replace(/\\/g, '/').includes('npm-cli.js'));
}

function resolveSystemNpmCliPath(): string | null {
  if (process.platform !== 'win32') {
    return null;
  }

  const candidates: string[] = [];

  try {
    const whereOutput = execSync('where.exe node', {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const firstNode = whereOutput.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (firstNode) {
      const nodeDir = path.dirname(firstNode);
      candidates.push(
        path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      );
    }
  } catch {
    // ignore
  }

  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  for (const base of [programFiles, programFilesX86]) {
    candidates.push(path.join(base, 'nodejs', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  }

  const appData = process.env.APPDATA;
  if (appData) {
    candidates.push(path.join(appData, 'npm', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  }

  for (const candidate of candidates) {
    if (isValidNpmCliPath(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * OpenClaw on Windows only accepts npm via npm_execpath pointing at npm-cli.js
 * (PATH/npm.cmd is ignored). Prefer bundled npm, then fall back to system Node.
 */
export function resolveNpmCliPath(): string | null {
  const bundled = getBundledNpmCliPath();
  if (isValidNpmCliPath(bundled)) {
    return bundled;
  }
  return resolveSystemNpmCliPath();
}

export function hasBundledNpmRuntime(): boolean {
  return isValidNpmCliPath(getBundledNpmCliPath());
}

export function hasNpmCliRuntime(): boolean {
  return resolveNpmCliPath() !== null;
}

export function buildBundledNpmEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  if (process.platform !== 'win32') {
    return env;
  }

  const npmCliPath = resolveNpmCliPath();
  if (!npmCliPath) {
    return env;
  }

  return {
    ...env,
    npm_execpath: npmCliPath,
  };
}

let ensurePromise: Promise<boolean> | null = null;

export async function ensureBundledNodeReady(): Promise<boolean> {
  if (process.platform !== 'win32') {
    return true;
  }

  if (hasNpmCliRuntime()) {
    const npmCliPath = resolveNpmCliPath();
    if (npmCliPath && !hasBundledNpmRuntime()) {
      logger.info(`[bundled-node] Using system npm-cli.js at ${npmCliPath}`);
    }
    return true;
  }

  if (!ensurePromise) {
    ensurePromise = Promise.resolve().then(() => downloadBundledNodeSync());
  }

  return ensurePromise;
}

function downloadBundledNodeSync(): boolean {
  if (hasNpmCliRuntime()) {
    return true;
  }

  const projectRoot = app.isPackaged ? path.join(process.resourcesPath, '..') : process.cwd();
  const scriptPath = path.join(projectRoot, 'scripts', 'download-bundled-node.mjs');
  if (!existsSync(scriptPath)) {
    logger.error(
      `[bundled-node] Missing ${scriptPath}. Install Node.js globally or run "pnpm run node:download:win:local".`,
    );
    return false;
  }

  logger.warn('[bundled-node] npm-cli.js missing; downloading bundled Node.js (current arch only)...');
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: projectRoot,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  });

  if (result.status !== 0) {
    const systemNpm = resolveSystemNpmCliPath();
    if (systemNpm) {
      logger.warn(`[bundled-node] Download failed; falling back to system npm-cli.js at ${systemNpm}`);
      return true;
    }
    logger.error(
      `[bundled-node] Failed to download bundled Node/npm (exit=${result.status ?? 'null'}). ` +
      'Install Node.js globally or run "pnpm run node:download:win:local", then restart LYClaw.',
    );
    return false;
  }

  if (!hasNpmCliRuntime()) {
    logger.error(
      '[bundled-node] Download finished but npm-cli.js is still missing at ' +
      `${getBundledNpmCliPath()}`,
    );
    return false;
  }

  logger.info(`[bundled-node] npm-cli.js ready (${resolveNpmCliPath()})`);
  return true;
}
