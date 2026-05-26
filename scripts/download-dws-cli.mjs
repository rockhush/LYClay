/**
 * download-dws-cli.mjs
 * 
 * Downloads DWS CLI binaries for all platforms during build time.
 * This ensures the binaries are bundled with the app, avoiding runtime downloads.
 * 
 * Usage:
 *   node scripts/download-dws-cli.mjs              # Download for current platform
 *   node scripts/download-dws-cli.mjs --all        # Download for all platforms
 *   node scripts/download-dws-cli.mjs --platform=win  # Download for Windows only
 */

import { $, fs, path } from 'zx';
import https from 'https';
import http from 'http';
import { createWriteStream } from 'fs';

const DWS_CLI_REPO = 'DingTalk-Real-AI/dingtalk-workspace-cli';
const DWS_CLI_API_URL = `https://api.github.com/repos/${DWS_CLI_REPO}/releases/latest`;

const ASSETS = {
  win: {
    x64: 'dws-windows-amd64.zip',
    arm64: 'dws-windows-arm64.zip',
  },
  mac: {
    x64: 'dws-darwin-amd64.tar.gz',
    arm64: 'dws-darwin-arm64.tar.gz',
  },
  linux: {
    x64: 'dws-linux-amd64.tar.gz',
    arm64: 'dws-linux-arm64.tar.gz',
  },
};

async function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https:') ? https : http;
    const file = createWriteStream(dest);

    protocol.get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        downloadFile(response.headers.location, dest).then(resolve).catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download: ${response.statusCode}`));
        return;
      }

      response.pipe(file);

      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', (err) => {
      fs.rm(dest, { force: true }).catch(() => {});
      reject(err);
    });
  });
}

async function fetchLatestRelease() {
  return new Promise((resolve, reject) => {
    const protocol = DWS_CLI_API_URL.startsWith('https:') ? https : http;

    protocol.get(DWS_CLI_API_URL, {
      headers: {
        'User-Agent': 'ClawX-Builder',
        'Accept': 'application/vnd.github.v3+json',
      },
    }, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        fetchLatestRelease().then(resolve).catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        reject(new Error(`GitHub API returned ${response.statusCode}`));
        return;
      }

      let data = '';
      response.on('data', (chunk) => { data += chunk; });

      response.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error('Failed to parse GitHub API response'));
        }
      });
    }).on('error', reject);
  });
}

async function downloadDwsCli(platform, arch) {
  const assetName = ASSETS[platform]?.[arch];
  if (!assetName) {
    console.warn(`⚠️  No asset for ${platform}/${arch}`);
    return;
  }

  const release = await fetchLatestRelease();
  const asset = release.assets.find((a) => a.name === assetName);

  if (!asset) {
    console.warn(`⚠️  Asset ${assetName} not found in release ${release.tag_name}`);
    return;
  }

  const outputDir = path.resolve('resources/bin', platform === 'mac' ? 'darwin' : platform);
  await fs.mkdir(outputDir, { recursive: true });

  const outputPath = path.join(outputDir, assetName);

  console.log(`📦 Downloading ${assetName} -> ${outputPath}`);
  await downloadFile(asset.browser_download_url, outputPath);
  console.log(`✅ Downloaded ${assetName} (${(asset.size / 1024 / 1024).toFixed(2)} MB)`);
}

// Parse arguments
const args = process.argv.slice(2);
const isAll = args.includes('--all');
const platformArg = args.find((a) => a.startsWith('--platform='))?.split('=')[1];

const targetPlatform = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';
const targetArch = process.arch === 'arm64' ? 'arm64' : 'x64';

async function main() {
  console.log('🚀 DWS CLI Pre-Download Script\n');

  if (isAll) {
    console.log('📥 Downloading DWS CLI for all platforms...\n');
    for (const [platform, archs] of Object.entries(ASSETS)) {
      for (const arch of Object.keys(archs)) {
        await downloadDwsCli(platform, arch);
      }
    }
  } else if (platformArg) {
    console.log(`📥 Downloading DWS CLI for ${platformArg}...\n`);
    const archs = Object.keys(ASSETS[platformArg] || {});
    for (const arch of archs) {
      await downloadDwsCli(platformArg, arch);
    }
  } else {
    console.log(`📥 Downloading DWS CLI for current platform (${targetPlatform}/${targetArch})...\n`);
    await downloadDwsCli(targetPlatform, targetArch);
  }

  console.log('\n✅ DWS CLI download complete!');
}

main().catch((error) => {
  console.error('❌ Failed to download DWS CLI:', error);
  process.exit(1);
});
