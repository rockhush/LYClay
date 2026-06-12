/**
 * Diagnose DWS CLI Installation Issues
 * 
 * Usage:
 *   node scripts/diagnose-dws.mjs
 */

import { fs, path } from 'zx';
import os from 'os';

function getHomeDir() {
  return os.homedir();
}

function getDwsDir() {
  return path.join(getHomeDir(), '.dws');
}

console.log('🔍 DWS CLI Installation Diagnosis\n');
console.log('='.repeat(60));

// 1. Check .dws directory
const dwsDir = getDwsDir();
console.log('\n📂 Checking DWS Directory:');
console.log(`   Path: ${dwsDir}`);

if (fs.existsSync(dwsDir)) {
  console.log('   Status: ✅ Exists');
  try {
    const items = fs.readdirSync(dwsDir);
    console.log(`   Contents (${items.length} items):`);
    items.forEach(item => {
      const itemPath = path.join(dwsDir, item);
      const stat = fs.statSync(itemPath);
      const isDir = stat.isDirectory();
      const size = isDir ? '' : `(${(stat.size / 1024 / 1024).toFixed(2)} MB)`;
      console.log(`     ${isDir ? '📁' : '📄'} ${item} ${size}`);
    });
  } catch (e) {
    console.log('   Error reading directory:', e.message);
  }
} else {
  console.log('   Status: ❌ Does not exist');
}

// 2. Check dws.exe
const dwsExe = path.join(dwsDir, 'dws.exe');
console.log('\n🔧 Checking DWS CLI Binary:');
console.log(`   Path: ${dwsExe}`);
if (fs.existsSync(dwsExe)) {
  const stat = fs.statSync(dwsExe);
  console.log(`   Status: ✅ Exists (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
} else {
  console.log('   Status: ❌ Not found - DWS CLI is NOT installed');
}

// 3. Check resources/bin
console.log('\n📦 Checking Bundled Resources:');
const resourcesBin = path.resolve('resources', 'bin');
console.log(`   Path: ${resourcesBin}`);

if (fs.existsSync(resourcesBin)) {
  console.log('   Status: ✅ Exists');
  
  // Check all possible platform directories
  const possibleDirs = ['win', 'win32', 'darwin', 'linux', 'win32-x64', 'win32-arm64'];
  possibleDirs.forEach(platform => {
    const platformDir = path.join(resourcesBin, platform);
    if (fs.existsSync(platformDir)) {
      const files = fs.readdirSync(platformDir);
      if (files.length > 0) {
        console.log(`   ${platform}/ (${files.length} files):`);
        files.forEach(file => {
          const filePath = path.join(platformDir, file);
          try {
            const stat = fs.statSync(filePath);
            const size = stat.isFile() ? `(${(stat.size / 1024 / 1024).toFixed(2)} MB)` : '';
            console.log(`     📦 ${file} ${size}`);
          } catch {
            console.log(`     📦 ${file}`);
          }
        });
      }
    }
  });
} else {
  console.log('   Status: ❌ Does not exist');
}

// 4. Diagnosis
console.log('\n' + '='.repeat(60));
console.log('📊 Diagnosis Result:\n');

if (!fs.existsSync(dwsExe)) {
  console.log('❌ DWS CLI is NOT installed!');
  console.log('\n💡 Solutions:\n');
  
  if (fs.existsSync(resourcesBin)) {
    const win32Dir = path.join(resourcesBin, 'win32');
    if (fs.existsSync(win32Dir)) {
      const zipFiles = fs.readdirSync(win32Dir).filter(f => f.endsWith('.zip'));
      if (zipFiles.length > 0) {
        console.log('1️⃣  Bundled archives found in resources/bin/win32/');
        console.log('   The DWS CLI should be auto-installed on app startup.');
        console.log('   Check ClawX logs for installation status.\n');
      }
    }
  }
  
  console.log('2️⃣  Manual installation:');
  console.log('   node scripts/install-dws-cli-manual.mjs\n');
  
  console.log('3️⃣  Download bundled archives (for packaging):');
  console.log('   pnpm dws:download:win\n');
} else {
  console.log('✅ DWS CLI is installed correctly!');
  console.log(`   Location: ${dwsExe}`);
}

console.log('\n' + '='.repeat(60));
