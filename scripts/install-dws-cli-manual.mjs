/**
 * Manual DWS CLI Installer
 * 
 * Use this script to manually install DWS CLI if the automatic installation fails.
 * 
 * Usage:
 *   node scripts/install-dws-cli-manual.mjs
 */

import { $, fs, path } from 'zx';
import https from 'https';
import http from 'http';
import { createWriteStream } from 'fs';
import { execSync } from 'child_process';
import os from 'os';

const DWS_CLI_REPO = 'DingTalk-Real-AI/dingtalk-workspace-cli';
const DWS_CLI_API_URL = `https://api.github.com/repos/${DWS_CLI_REPO}/releases/latest`;

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
        'User-Agent': 'ClawX-Manual-Installer',
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

function getHomeDir() {
  return os.homedir();
}

function getDwsDir() {
  return path.join(getHomeDir(), '.dws');
}

async function main() {
  console.log('🔧 Manual DWS CLI Installer\n');

  const platform = process.platform;
  const arch = process.arch;

  console.log(`Platform: ${platform}`);
  console.log(`Architecture: ${arch}`);

  // Determine asset name
  let assetName;
  if (platform === 'win32') {
    assetName = arch === 'arm64' ? 'dws-windows-arm64.zip' : 'dws-windows-amd64.zip';
  } else if (platform === 'darwin') {
    assetName = arch === 'arm64' ? 'dws-darwin-arm64.tar.gz' : 'dws-darwin-amd64.tar.gz';
  } else if (platform === 'linux') {
    assetName = arch === 'arm64' ? 'dws-linux-arm64.tar.gz' : 'dws-linux-amd64.tar.gz';
  } else {
    console.error('❌ Unsupported platform');
    process.exit(1);
  }

  console.log(`\n Downloading ${assetName}...\n`);

  // Fetch latest release
  const release = await fetchLatestRelease();
  const asset = release.assets.find((a) => a.name === assetName);

  if (!asset) {
    console.error(`❌ Asset ${assetName} not found in release ${release.tag_name}`);
    process.exit(1);
  }

  // Download
  const tempDir = path.join(os.tmpdir(), 'dws-cli-install');
  await fs.mkdir(tempDir, { recursive: true });

  const archivePath = path.join(tempDir, assetName);
  await downloadFile(asset.browser_download_url, archivePath);

  console.log(`✅ Downloaded to: ${archivePath}`);
  console.log(`   Size: ${(asset.size / 1024 / 1024).toFixed(2)} MB\n`);

  // Extract
  const dwsDir = getDwsDir();
  await fs.mkdir(dwsDir, { recursive: true });

  console.log(`📂 Extracting to: ${dwsDir}\n`);

  if (assetName.endsWith('.zip')) {
    const psCmd = `Expand-Archive -Path "${archivePath}" -DestinationPath "${tempDir}\\extracted" -Force`;
    execSync(`powershell -Command "${psCmd}"`, { stdio: 'inherit' });

    // Find and copy dws.exe
    const extractedDir = path.join(tempDir, 'extracted');
    const binaryName = 'dws.exe';

    // Find dws.exe in extracted files
    const findCmd = `Get-ChildItem -Path "${extractedDir}" -Recurse -Filter "${binaryName}" | Select-Object -First 1 -ExpandProperty FullName`;
    const exePath = execSync(`powershell -Command "${findCmd}"`, { encoding: 'utf-8' }).trim();

    if (exePath) {
      const targetPath = path.join(dwsDir, binaryName);
      await fs.copyFile(exePath, targetPath);
      console.log(`✅ Installed to: ${targetPath}\n`);
    } else {
      console.error('❌ dws.exe not found in archive');
      process.exit(1);
    }
  } else {
    // tar.gz extraction
    execSync(`tar -xzf "${archivePath}" -C "${tempDir}"`, { stdio: 'inherit' });

    const binaryName = 'dws';
    const findCmd = `find "${tempDir}" -name "${binaryName}" -type f | head -1`;
    const exePath = execSync(findCmd, { encoding: 'utf-8' }).trim();

    if (exePath) {
      const targetPath = path.join(dwsDir, binaryName);
      await fs.copyFile(exePath, targetPath);
      execSync(`chmod +x "${targetPath}"`);
      console.log(`✅ Installed to: ${targetPath}\n`);
    } else {
      console.error(' dws binary not found in archive');
      process.exit(1);
    }
  }

  // Cleanup
  await fs.rm(tempDir, { recursive: true, force: true });

  const finalPath = path.join(dwsDir, platform === 'win32' ? 'dws.exe' : 'dws');

  console.log('\n' + '='.repeat(60));
  console.log('🎉 DWS CLI Installation Complete!');
  console.log('='.repeat(60));
  console.log('\n📍 Installation Location:');
  console.log(`   ${finalPath}`);
  console.log('\n📂 DWS Directory:');
  console.log(`   ${dwsDir}`);
  console.log('\n📋 Directory Contents:');
  
  try {
    const items = fs.readdirSync(dwsDir);
    items.forEach(item => {
      const itemPath = path.join(dwsDir, item);
      const stat = fs.statSync(itemPath);
      const size = stat.isFile() ? `(${(stat.size / 1024 / 1024).toFixed(2)} MB)` : '';
      console.log(`   ${stat.isDirectory() ? '📁' : '📄'} ${item} ${size}`);
    });
  } catch {
    console.log('   (Unable to list directory)');
  }
  
  console.log('\n✅ You can now use DWS CLI:');
  console.log(`   ${finalPath} --version`);
  console.log(`   ${finalPath} --help`);
  
  if (platform === 'win32') {
    console.log('\n💡 Tip: Add to PATH for easier access:');
    console.log(`   $env:Path += ";${dwsDir}"`);
    console.log('   (Or add permanently via System Environment Variables)');
  } else {
    console.log('\n💡 Tip: Add to PATH for easier access:');
    console.log(`   echo 'export PATH="$HOME/.dws:$PATH"' >> ~/.zshrc`);
    console.log('   source ~/.zshrc');
  }
  
  console.log('\n' + '='.repeat(60) + '\n');
}

main().catch((error) => {
  console.error('❌ Failed to install DWS CLI:', error);
  process.exit(1);
});
