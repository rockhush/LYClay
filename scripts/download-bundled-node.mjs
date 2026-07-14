#!/usr/bin/env zx

import 'zx/globals';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE_VERSION = '22.19.0';
const LOCAL_PACKAGES_DIR = path.resolve('D:\\lycode\\packages\\node');
const PACKAGES_DIR = path.join(ROOT_DIR, 'packages', 'node');
const OUTPUT_BASE = path.join(ROOT_DIR, 'resources', 'bin');

function buildDownloadUrls(filename) {
  return [
    `https://npmmirror.com/mirrors/node/v${NODE_VERSION}/${filename}`,
    `https://nodejs.org/dist/v${NODE_VERSION}/${filename}`,
  ];
}

async function downloadWithFallback(urls, archivePath) {
  let lastError = null;
  for (const downloadUrl of urls) {
    try {
      echo(`Downloading: ${downloadUrl}`);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      const response = await fetch(downloadUrl, { signal: controller.signal });
      clearTimeout(timeout);
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      const buffer = await response.arrayBuffer();
      await fs.writeFile(archivePath, Buffer.from(buffer));
      return;
    } catch (error) {
      lastError = error;
      echo(chalk.yellow(`Download failed from ${downloadUrl}: ${error}`));
    }
  }
  throw lastError ?? new Error('All download mirrors failed');
}

const TARGETS = {
  'darwin-x64': {
    filename: `node-v${NODE_VERSION}-darwin-x64.tar.gz`,
    sourceDir: `node-v${NODE_VERSION}-darwin-x64`,
    nodeRelativePath: 'bin/node',
    outputNodeName: 'node',
    includeNpm: false,
  },
  'darwin-arm64': {
    filename: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
    sourceDir: `node-v${NODE_VERSION}-darwin-arm64`,
    nodeRelativePath: 'bin/node',
    outputNodeName: 'node',
    includeNpm: false,
  },
  'linux-x64': {
    filename: `node-v${NODE_VERSION}-linux-x64.tar.gz`,
    sourceDir: `node-v${NODE_VERSION}-linux-x64`,
    nodeRelativePath: 'bin/node',
    outputNodeName: 'node',
    includeNpm: false,
  },
  'linux-arm64': {
    filename: `node-v${NODE_VERSION}-linux-arm64.tar.gz`,
    sourceDir: `node-v${NODE_VERSION}-linux-arm64`,
    nodeRelativePath: 'bin/node',
    outputNodeName: 'node',
    includeNpm: false,
  },
  'win32-x64': {
    filename: `node-v${NODE_VERSION}-win-x64.zip`,
    sourceDir: `node-v${NODE_VERSION}-win-x64`,
    nodeRelativePath: 'node.exe',
    outputNodeName: 'node.exe',
    includeNpm: true,
  },
  'win32-arm64': {
    filename: `node-v${NODE_VERSION}-win-arm64.zip`,
    sourceDir: `node-v${NODE_VERSION}-win-arm64`,
    nodeRelativePath: 'node.exe',
    outputNodeName: 'node.exe',
    includeNpm: true,
  },
};

const PLATFORM_GROUPS = {
  mac: ['darwin-x64', 'darwin-arm64'],
  win: ['win32-x64', 'win32-arm64'],
  linux: ['linux-x64', 'linux-arm64'],
};

function resolveArchive(filename) {
  const candidates = [
    path.join(LOCAL_PACKAGES_DIR, filename),
    path.join(PACKAGES_DIR, filename),
    path.join(ROOT_DIR, filename),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

async function extractArchive(archivePath, tempDir) {
  if (archivePath.endsWith('.zip')) {
    if (os.platform() === 'win32') {
      const { execFileSync } = await import('node:child_process');
      const psCommand = `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory('${archivePath.replace(/'/g, "''")}', '${tempDir.replace(/'/g, "''")}')`;
      execFileSync('powershell.exe', ['-NoProfile', '-Command', psCommand], { stdio: 'inherit' });
    } else {
      await $`unzip -q -o ${archivePath} -d ${tempDir}`;
    }
    return;
  }
  await $`tar -xzf ${archivePath} -C ${tempDir}`;
}

async function removeTargetNodeAssets(targetDir, target) {
  const outputNode = path.join(targetDir, target.outputNodeName);
  await fs.remove(outputNode);
  if (!target.includeNpm) return;
  await fs.remove(path.join(targetDir, 'npm.cmd'));
  await fs.remove(path.join(targetDir, 'npx.cmd'));
  await fs.remove(path.join(targetDir, 'node_modules', 'npm'));
}

async function copyNodeBinary(sourceRoot, targetDir, target) {
  const outputNode = path.join(targetDir, target.outputNodeName);
  const expectedNode = path.join(sourceRoot, target.nodeRelativePath);
  if (await fs.pathExists(expectedNode)) {
    await fs.copy(expectedNode, outputNode, { overwrite: true });
  } else {
    echo(chalk.yellow(`${target.outputNodeName} not found in expected directory, searching...`));
    const files = await glob(`**/${target.outputNodeName}`, { cwd: path.dirname(sourceRoot), absolute: true });
    if (!files.length) throw new Error(`Could not find ${target.outputNodeName} in extracted files.`);
    await fs.copy(files[0], outputNode, { overwrite: true });
  }
  if (target.outputNodeName === 'node') await fs.chmod(outputNode, 0o755);
}

async function copyWindowsNpmAssets(sourceRoot, targetDir) {
  const npmAssets = [
    ['npm.cmd', path.join(targetDir, 'npm.cmd')],
    ['npx.cmd', path.join(targetDir, 'npx.cmd')],
    [path.join('node_modules', 'npm'), path.join(targetDir, 'node_modules', 'npm')],
  ];
  for (const [relativeSource, outputPath] of npmAssets) {
    const sourcePath = path.join(sourceRoot, relativeSource);
    if (!(await fs.pathExists(sourcePath))) {
      throw new Error(`Could not find ${relativeSource} in extracted Node.js package.`);
    }
    await fs.copy(sourcePath, outputPath, { overwrite: true });
  }

  const npmCliPath = path.join(targetDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!(await fs.pathExists(npmCliPath))) {
    throw new Error(`Extracted npm package is incomplete: missing ${npmCliPath}`);
  }
}

async function setupTarget(id) {
  const target = TARGETS[id];
  if (!target) {
    echo(chalk.yellow(`Target ${id} is not supported by this script.`));
    return;
  }

  const targetDir = path.join(OUTPUT_BASE, id);
  const tempDir = path.join(ROOT_DIR, 'temp_node_extract');
  const downloadUrls = buildDownloadUrls(target.filename);

  echo(chalk.blue(`\nSetting up Node.js for ${id}...`));
  await removeTargetNodeAssets(targetDir, target);
  await fs.remove(tempDir);
  await fs.ensureDir(targetDir);
  await fs.ensureDir(tempDir);

  try {
    const localArchive = resolveArchive(target.filename);
    let archivePath = localArchive;
    if (archivePath) {
      echo(`Using local archive: ${archivePath}`);
    } else {
      archivePath = path.join(ROOT_DIR, target.filename);
      await downloadWithFallback(downloadUrls, archivePath);
    }

    echo('Extracting...');
    await extractArchive(archivePath, tempDir);

    const sourceRoot = path.join(tempDir, target.sourceDir);
    await copyNodeBinary(sourceRoot, targetDir, target);
    if (target.includeNpm) await copyWindowsNpmAssets(sourceRoot, targetDir);

    echo(chalk.green(`Success: ${path.join(targetDir, target.outputNodeName)}`));
  } finally {
    const rootArchive = path.join(ROOT_DIR, target.filename);
    if (await fs.pathExists(rootArchive)) await fs.remove(rootArchive);
    await fs.remove(tempDir);
  }
}

const downloadAll = argv.all;
const platform = argv.platform;

if (downloadAll) {
  echo(chalk.cyan('Downloading Node.js binaries for all supported targets...'));
  for (const id of Object.keys(TARGETS)) await setupTarget(id);
} else if (platform) {
  const targets = PLATFORM_GROUPS[platform];
  if (!targets) {
    echo(chalk.red(`Unknown platform: ${platform}`));
    echo(`Available platforms: ${Object.keys(PLATFORM_GROUPS).join(', ')}`);
    process.exit(1);
  }
  echo(chalk.cyan(`Downloading Node.js binaries for platform: ${platform}`));
  for (const id of targets) await setupTarget(id);
} else {
  const currentId = `${os.platform()}-${os.arch()}`;
  if (!TARGETS[currentId]) {
    echo(chalk.red(`Current system ${currentId} is not in the supported download list.`));
    echo(`Supported targets: ${Object.keys(TARGETS).join(', ')}`);
    process.exit(1);
  }
  echo(chalk.cyan(`Detected system: ${currentId}`));
  await setupTarget(currentId);
}

echo(chalk.green('\nDone!'));
