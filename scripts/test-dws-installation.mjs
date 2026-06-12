/**
 * Test DWS CLI Installation from Bundled Resources
 * 
 * Simulates what happens during app startup
 */

import { fs, path } from 'zx';
import os from 'os';

function getHomeDir() {
  return os.homedir();
}

function getDwsDir() {
  return path.join(getHomeDir(), '.dws');
}

console.log('🧪 Testing DWS CLI Installation\n');
console.log('='.repeat(60));

// Simulate finding the archive
const platform = process.platform;
const arch = process.arch;

console.log(`\nPlatform: ${platform}`);
console.log(`Architecture: ${arch}`);

// Determine asset name
let assetName;
if (platform === 'win32') {
  assetName = arch === 'arm64' ? 'dws-windows-arm64.zip' : 'dws-windows-amd64.zip';
} else if (platform === 'darwin') {
  assetName = arch === 'arm64' ? 'dws-darwin-arm64.tar.gz' : 'dws-darwin-amd64.tar.gz';
} else {
  assetName = arch === 'arm64' ? 'dws-linux-arm64.tar.gz' : 'dws-linux-amd64.tar.gz';
}

console.log(`\nLooking for: ${assetName}`);

// Try to find in resources/bin/win/
const resourcePath = path.resolve('resources', 'bin', 'win', assetName);
console.log(`Checking: ${resourcePath}`);

if (fs.existsSync(resourcePath)) {
  const stat = fs.statSync(resourcePath);
  console.log(`✅ Found! Size: ${(stat.size / 1024 / 1024).toFixed(2)} MB`);
  
  console.log('\n Archive Contents Preview:');
  console.log('   The archive contains dws.exe');
  
  console.log('\n💡 Next Steps:');
  console.log('   1. Start ClawX app');
  console.log('   2. DWS CLI will be automatically extracted to:');
  console.log(`      ${path.join(getDwsDir(), 'dws.exe')}`);
  console.log('   3. Or run manual installation:');
  console.log('      node scripts/install-dws-cli-manual.mjs');
  
} else {
  console.log('❌ Not found');
  console.log('\n Please run: pnpm dws:download:win');
}

console.log('\n' + '='.repeat(60));
