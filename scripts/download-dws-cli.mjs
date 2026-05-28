/**
 * download-dws-cli.mjs
 *
 * Downloads DWS CLI binaries during build time.
 *
 * Usage:
 *   node scripts/download-dws-cli.mjs                 # Download for current platform/arch
 *   node scripts/download-dws-cli.mjs --all           # Download for all platforms
 *   node scripts/download-dws-cli.mjs --platform=mac  # Download both mac architectures
 */

import { createWriteStream } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { fs, path } from 'zx';

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

async function downloadToTemp(url, tempDest) {
  await new Promise((resolve, reject) => {
    const protocol = url.startsWith('https:') ? https : http;

    protocol.get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        downloadToTemp(response.headers.location, tempDest).then(resolve).catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download ${url}: HTTP ${response.statusCode}`));
        return;
      }

      const file = createWriteStream(tempDest);
      response.pipe(file);
      file.on('finish', () => {
        file.close(resolve);
      });
      file.on('error', (error) => {
        file.close();
        void fs.rm(tempDest, { force: true }).catch(() => {});
        reject(error);
      });
    }).on('error', (error) => {
      void fs.rm(tempDest, { force: true }).catch(() => {});
      reject(error);
    });
  });
}

async function downloadFile(url, dest) {
  const tempDest = `${dest}.tmp-${process.pid}-${Date.now()}`;

  await fs.rm(tempDest, { force: true }).catch(() => {});
  await downloadToTemp(url, tempDest);

  const stat = await fs.stat(tempDest);
  if (stat.size <= 0) {
    await fs.rm(tempDest, { force: true }).catch(() => {});
    throw new Error(`Downloaded file is empty: ${url}`);
  }

  await fs.rm(dest, { force: true }).catch(() => {});
  await fs.rename(tempDest, dest);
}

async function fetchLatestRelease() {
  return new Promise((resolve, reject) => {
    const protocol = DWS_CLI_API_URL.startsWith('https:') ? https : http;

    protocol.get(DWS_CLI_API_URL, {
      headers: {
        'User-Agent': 'ClawX-Builder',
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
      },
    }, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        fetchLatestRelease().then(resolve).catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        reject(new Error(`GitHub API returned HTTP ${response.statusCode}`));
        return;
      }

      let data = '';
      response.on('data', (chunk) => {
        data += chunk;
      });
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
    throw new Error(`No DWS CLI asset configured for ${platform}/${arch}`);
  }

  const release = await fetchLatestRelease();
  const asset = release.assets.find((item) => item.name === assetName);
  if (!asset) {
    throw new Error(`Asset ${assetName} not found in release ${release.tag_name}`);
  }

  const outputDir = path.resolve('resources/bin', platform === 'mac' ? 'darwin' : platform);
  await fs.mkdir(outputDir, { recursive: true });

  const outputPath = path.join(outputDir, assetName);
  console.log(`[DWS] Downloading ${assetName} -> ${outputPath}`);
  await downloadFile(asset.browser_download_url, outputPath);
  console.log(`[DWS] Downloaded ${assetName} (${(asset.size / 1024 / 1024).toFixed(2)} MB)`);
}

const args = process.argv.slice(2);
const isAll = args.includes('--all');
const platformArg = args.find((arg) => arg.startsWith('--platform='))?.split('=')[1];

const targetPlatform = process.platform === 'win32'
  ? 'win'
  : process.platform === 'darwin'
    ? 'mac'
    : 'linux';
const targetArch = process.arch === 'arm64' ? 'arm64' : 'x64';

async function main() {
  console.log('[DWS] Pre-download started');

  if (isAll) {
    for (const [platform, archs] of Object.entries(ASSETS)) {
      for (const arch of Object.keys(archs)) {
        await downloadDwsCli(platform, arch);
      }
    }
  } else if (platformArg) {
    const archs = Object.keys(ASSETS[platformArg] || {});
    if (archs.length === 0) {
      throw new Error(`Unknown DWS platform: ${platformArg}`);
    }
    for (const arch of archs) {
      await downloadDwsCli(platformArg, arch);
    }
  } else {
    await downloadDwsCli(targetPlatform, targetArch);
  }

  console.log('[DWS] Pre-download complete');
}

main().catch((error) => {
  console.error('[DWS] Failed to download DWS CLI:', error);
  process.exit(1);
});
