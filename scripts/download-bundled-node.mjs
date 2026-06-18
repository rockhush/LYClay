#!/usr/bin/env zx

import 'zx/globals';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE_VERSION = '22.19.0';
const OUTPUT_BASE = path.join(ROOT_DIR, 'resources', 'bin');

function buildDownloadUrls(filename) {
  return [
    `https://nodejs.org/dist/v${NODE_VERSION}/${filename}`,
    `https://npmmirror.com/mirrors/node/v${NODE_VERSION}/${filename}`,
  ];
}

async function downloadWithFallback(urls, archivePath) {
  let lastError = null;
  for (const downloadUrl of urls) {
    try {
      echo`⬇️ Downloading: ${downloadUrl}`;
      const response = await fetch(downloadUrl);
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

async function setupTarget(id) {
  const target = TARGETS[id];
  if (!target) {
    echo(chalk.yellow`⚠️ Target ${id} is not supported by this script.`);
    return;
  }

  const targetDir = path.join(OUTPUT_BASE, id);
  const tempDir = path.join(ROOT_DIR, 'temp_node_extract');
  const archivePath = path.join(ROOT_DIR, target.filename);
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
    await downloadWithFallback(downloadUrls, archivePath);

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
    await fs.remove(archivePath);
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
