#!/usr/bin/env zx

import 'zx/globals';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PYTHON_VERSION = '3.12';
const DEFAULT_PYTHON_MIRROR = 'https://registry.npmmirror.com/-/binary/python-build-standalone/';

const TARGETS = {
  'darwin-x64': { platform: 'darwin', arch: 'x64', uvBin: 'uv', pythonTarget: 'cpython-3.12-macos-x86_64-none' },
  'darwin-arm64': { platform: 'darwin', arch: 'arm64', uvBin: 'uv', pythonTarget: 'cpython-3.12-macos-aarch64-none' },
  'linux-x64': { platform: 'linux', arch: 'x64', uvBin: 'uv', pythonTarget: 'cpython-3.12-linux-x86_64-gnu' },
  'linux-arm64': { platform: 'linux', arch: 'arm64', uvBin: 'uv', pythonTarget: 'cpython-3.12-linux-aarch64-gnu' },
  'win32-x64': { platform: 'win32', arch: 'x64', uvBin: 'uv.exe', pythonTarget: 'cpython-3.12-windows-x86_64-none' },
  'win32-arm64': { platform: 'win32', arch: 'arm64', uvBin: 'uv.exe', pythonTarget: 'cpython-3.12-windows-aarch64-none' },
};

const PLATFORM_GROUPS = {
  mac: ['darwin-x64', 'darwin-arm64'],
  win: ['win32-x64'],
  linux: ['linux-x64', 'linux-arm64'],
};

function currentTargetId() {
  return `${os.platform()}-${os.arch()}`;
}

function resolveRequestedTargets() {
  if (argv.all) return Object.keys(TARGETS);

  const platform = argv.platform;
  if (platform) {
    const targets = PLATFORM_GROUPS[platform];
    if (!targets) {
      echo(chalk.red(`Unknown platform: ${platform}`));
      echo(`Available platforms: ${Object.keys(PLATFORM_GROUPS).join(', ')}`);
      process.exit(1);
    }
    return targets;
  }

  const current = currentTargetId();
  if (!TARGETS[current]) {
    echo(chalk.red(`Current system ${current} is not in the supported target list.`));
    echo(`Supported targets: ${Object.keys(TARGETS).join(', ')}`);
    process.exit(1);
  }
  return [current];
}

async function findBundledPythonExecutable(id) {
  const target = TARGETS[id];
  const installDir = path.join(ROOT_DIR, 'resources', 'python', id);
  if (!(await fs.pathExists(installDir))) return null;
  const binaryName = target.platform === 'win32' ? 'python.exe' : 'python';
  const candidates = await glob(`**/${binaryName}`, {
    cwd: installDir,
    absolute: true,
    onlyFiles: true,
  });
  return candidates.find((candidate) => /cpython/i.test(candidate)) ?? candidates[0] ?? null;
}

async function verifyPrebuiltTargetPython(id) {
  const installDir = path.join(ROOT_DIR, 'resources', 'python', id);
  const pythonPath = await findBundledPythonExecutable(id);
  if (pythonPath) {
    echo(chalk.green(`Prebuilt Python exists for ${id}: ${pythonPath}`));
    return;
  }

  throw new Error(
    `Cannot prepare ${id} Python from ${currentTargetId()}, and no prebuilt Python was found under ${installDir}. ` +
    `Prepare it on a ${id} machine or restore the cached resources/python/${id} directory before packaging.`
  );
}

function runUv(command, args, env) {
  const result = spawnSync(command, args, {
    env,
    encoding: 'utf8',
    windowsHide: true,
  });
  return {
    code: result.status ?? 1,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? result.error?.message ?? ''),
  };
}

async function normalizeInstallDirSymlinks(installDir) {
  if (!(await fs.pathExists(installDir))) return;
  const entries = await fs.readdir(installDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isSymbolicLink()) continue;

    const linkPath = path.join(installDir, entry.name);
    const target = await fs.readlink(linkPath);
    if (!path.isAbsolute(target)) continue;

    const relativeTarget = path.relative(installDir, target);
    if (relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) continue;

    await fs.unlink(linkPath);
    await fs.symlink(relativeTarget, linkPath);
    echo(chalk.gray(`Rewrote Python symlink: ${linkPath} -> ${relativeTarget}`));
  }
}

async function ensureTargetPython(id) {
  const target = TARGETS[id];
  const current = currentTargetId();
  const currentTarget = TARGETS[current];
  const uvTargetId = currentTarget && currentTarget.platform === target.platform ? current : id;
  const uvTarget = TARGETS[uvTargetId];
  const uvBin = path.join(ROOT_DIR, 'resources', 'bin', uvTargetId, uvTarget.uvBin);
  const installDir = path.join(ROOT_DIR, 'resources', 'python', id);

  if (!currentTarget || currentTarget.platform !== target.platform) {
    await verifyPrebuiltTargetPython(id);
    return;
  }

  if (!(await fs.pathExists(uvBin))) {
    throw new Error(`Bundled uv is missing for ${id}: ${uvBin}`);
  }

  await fs.ensureDir(installDir);

  const env = {
    ...process.env,
    UV_PYTHON_INSTALL_DIR: installDir,
    UV_PYTHON_INSTALL_MIRROR: process.env.OPENCLAW_PYTHON_INSTALL_MIRROR || DEFAULT_PYTHON_MIRROR,
    UV_INDEX_URL: process.env.OPENCLAW_UV_INDEX_URL || 'https://pypi.tuna.tsinghua.edu.cn/simple/',
  };

  echo(chalk.blue(`\nPreparing bundled Python ${PYTHON_VERSION} for ${id}...`));

  const findBefore = runUv(uvBin, ['python', 'find', PYTHON_VERSION, '--managed-python', '--no-python-downloads'], env);
  if (findBefore.code === 0 && findBefore.stdout.trim()) {
    await normalizeInstallDirSymlinks(installDir);
    echo(chalk.green(`Python already exists: ${findBefore.stdout.trim().split(/\r?\n/)[0]}`));
    return;
  }

  const install = runUv(uvBin, [
    'python',
    'install',
    target.pythonTarget,
    '--install-dir',
    installDir,
    '--no-bin',
    '--no-registry',
  ], env);

  if (install.code !== 0) {
    throw new Error(
      `Failed to prepare bundled Python for ${id}.\n` +
      `stdout:\n${install.stdout || '(empty)'}\n` +
      `stderr:\n${install.stderr || '(empty)'}`
    );
  }

  const findAfter = runUv(uvBin, ['python', 'find', PYTHON_VERSION, '--managed-python', '--no-python-downloads'], env);
  if (findAfter.code !== 0 || !findAfter.stdout.trim()) {
    throw new Error(`Installed Python for ${id}, but uv could not find it under ${installDir}.`);
  }

  await normalizeInstallDirSymlinks(installDir);
  echo(chalk.green(`Bundled Python ready: ${findAfter.stdout.trim().split(/\r?\n/)[0]}`));
}

for (const target of resolveRequestedTargets()) {
  await ensureTargetPython(target);
}

echo(chalk.green('\nDone!'));
