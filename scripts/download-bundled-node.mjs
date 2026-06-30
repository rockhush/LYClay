#!/usr/bin/env zx

import 'zx/globals';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE_VERSION = '22.19.0';
// 本地离线包优先目录 (D:\lycode\packages)
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
      echo`⬇️ Downloading: ${downloadUrl}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      const response = await fetch(downloadUrl, { signal: controller.signal });
      clearTimeout(timeout);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      const buffer = await response.arrayBuffer();
      await fs.writeFile(archivePath, Buffer.from(buffer));
      return;
    } catch (error) {
      lastError = error;
      echo(chalk.yellow`⚠️ Download failed from ${downloadUrl}: ${error}`);
    }
  }
  throw lastError ?? new Error('All download mirrors failed');
}

const TARGETS = {
  'win32-x64': {
    filename: `node-v${NODE_VERSION}-win-x64.zip`,
    sourceDir: `node-v${NODE_VERSION}-win-x64`,
  },
  'win32-arm64': {
    filename: `node-v${NODE_VERSION}-win-arm64.zip`,
    sourceDir: `node-v${NODE_VERSION}-win-arm64`,
  },
};

const PLATFORM_GROUPS = {
  win: ['win32-x64', 'win32-arm64'],
};

function resolveArchive(filename) {
  // 1. D:\lycode\packages\node\ 全局离线目录 (优先)
  const localPath = path.join(LOCAL_PACKAGES_DIR, filename);
  if (fs.existsSync(localPath)) return localPath;
  // 2. packages/node/ 项目内目录
  const pkgPath = path.join(PACKAGES_DIR, filename);
  if (fs.existsSync(pkgPath)) return pkgPath;
  // 3. 项目根目录 (兼容旧方式)
  const rootPath = path.join(ROOT_DIR, filename);
  if (fs.existsSync(rootPath)) return rootPath;
  return null;
}

async function setupTarget(id) {
  const target = TARGETS[id];
  if (!target) {
    echo(chalk.yellow`⚠️ Target ${id} is not supported by this script.`);
    return;
  }

  const targetDir = path.join(OUTPUT_BASE, id);
  const tempDir = path.join(ROOT_DIR, 'temp_node_extract');
  const downloadUrls = buildDownloadUrls(target.filename);

  echo(chalk.blue`\n📦 Setting up Node.js for ${id}...`);

  // Only remove Node/npm assets, not the entire directory,
  // to avoid deleting uv.exe or other binaries placed by other download scripts.
  const outputNode = path.join(targetDir, 'node.exe');
  const outputNpm = path.join(targetDir, 'npm.cmd');
  const outputNpx = path.join(targetDir, 'npx.cmd');
  const outputNpmPackage = path.join(targetDir, 'node_modules', 'npm');
  for (const outputPath of [outputNode, outputNpm, outputNpx, outputNpmPackage]) {
    if (await fs.pathExists(outputPath)) {
      await fs.remove(outputPath);
    }
  }
  await fs.remove(tempDir);
  await fs.ensureDir(targetDir);
  await fs.ensureDir(tempDir);

  try {
    // Use pre-downloaded archive if present, otherwise download from network
    const localArchive = resolveArchive(target.filename);
    if (localArchive) {
      echo`📁 Using local archive: ${localArchive}`;
      var archivePath = localArchive;
    } else {
      const dlPath = path.join(ROOT_DIR, target.filename);
      await downloadWithFallback(downloadUrls, dlPath);
      archivePath = dlPath;
    }

    echo`📂 Extracting...`;
    if (os.platform() === 'win32') {
      const { execFileSync } = await import('child_process');
      const psCommand = `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory('${archivePath.replace(/'/g, "''")}', '${tempDir.replace(/'/g, "''")}')`;
      execFileSync('powershell.exe', ['-NoProfile', '-Command', psCommand], { stdio: 'inherit' });
    } else {
      await $`unzip -q -o ${archivePath} -d ${tempDir}`;
    }

    const sourceRoot = path.join(tempDir, target.sourceDir);
    const expectedNode = path.join(sourceRoot, 'node.exe');
    if (await fs.pathExists(expectedNode)) {
      await fs.move(expectedNode, outputNode, { overwrite: true });
    } else {
      echo(chalk.yellow`🔍 node.exe not found in expected directory, searching...`);
      const files = await glob('**/node.exe', { cwd: tempDir, absolute: true });
      if (files.length > 0) {
        await fs.move(files[0], outputNode, { overwrite: true });
      } else {
        throw new Error('Could not find node.exe in extracted files.');
      }
    }

    const npmAssets = [
      ['npm.cmd', outputNpm],
      ['npx.cmd', outputNpx],
      [path.join('node_modules', 'npm'), outputNpmPackage],
    ];
    for (const [relativeSource, outputPath] of npmAssets) {
      const sourcePath = path.join(sourceRoot, relativeSource);
      if (!(await fs.pathExists(sourcePath))) {
        throw new Error(`Could not find ${relativeSource} in extracted Node.js package.`);
      }
      await fs.move(sourcePath, outputPath, { overwrite: true });
    }

    const npmCliPath = path.join(targetDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (!(await fs.pathExists(npmCliPath))) {
      throw new Error(`Extracted npm package is incomplete: missing ${npmCliPath}`);
    }

    echo(chalk.green`✅ Success: ${outputNode} + npm-cli.js`);
  } finally {
    // Cleanup — only delete temp downloads in project root, not packages/ or D:\lycode\packages\ files
    const rootArchive = path.join(ROOT_DIR, target.filename);
    if (await fs.pathExists(rootArchive)) {
      await fs.remove(rootArchive);
    }
    // Also clean up the LOCAL_PACKAGES_DIR download if accidentally placed there as temp
    const localTempArchive = path.join(LOCAL_PACKAGES_DIR, target.filename);
    // (intentionally kept — it's the permanent local cache)
    await fs.remove(tempDir);
  }
}

const downloadAll = argv.all;
const platform = argv.platform;

if (downloadAll) {
  echo(chalk.cyan`🌐 Downloading Node.js binaries for all Windows targets...`);
  for (const id of Object.keys(TARGETS)) {
    await setupTarget(id);
  }
} else if (platform) {
  const targets = PLATFORM_GROUPS[platform];
  if (!targets) {
    echo(chalk.red`❌ Unknown platform: ${platform}`);
    echo(`Available platforms: ${Object.keys(PLATFORM_GROUPS).join(', ')}`);
    process.exit(1);
  }
  echo(chalk.cyan`🎯 Downloading Node.js binaries for platform: ${platform}`);
  for (const id of targets) {
    await setupTarget(id);
  }
} else {
  const currentId = `${os.platform()}-${os.arch()}`;
  if (TARGETS[currentId]) {
    echo(chalk.cyan`💻 Detected Windows system: ${currentId}`);
    await setupTarget(currentId);
  } else {
    echo(chalk.cyan`🎯 Defaulting to Windows multi-arch Node.js download`);
    for (const id of PLATFORM_GROUPS.win) {
      await setupTarget(id);
    }
  }
}

echo(chalk.green`\n🎉 Done!`);
