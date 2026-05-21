/**
 * Check if DWS CLI was added to PATH
 */

import { fs } from 'zx';
import { execSync } from 'child_process';
import os from 'os';

console.log(' Checking DWS CLI PATH Configuration\n');
console.log('='.repeat(60));

const dwsDir = os.homedir() + '\\.dws';
const dwsExe = dwsDir + '\\dws.exe';

// 1. Check if dws.exe exists
console.log('\n📁 DWS Directory Check:');
console.log(`   Path: ${dwsDir}`);
if (fs.existsSync(dwsDir)) {
  console.log('   Status: ✅ Exists');
  
  try {
    const files = fs.readdirSync(dwsDir);
    console.log(`   Files: ${files.join(', ')}`);
  } catch {
    console.log('   (Unable to list files)');
  }
} else {
  console.log('   Status: ❌ Not found');
}

// 2. Check if dws.exe exists
console.log('\n🔧 DWS CLI Binary Check:');
console.log(`   Path: ${dwsExe}`);
if (fs.existsSync(dwsExe)) {
  console.log('   Status: ✅ Exists');
} else {
  console.log('   Status: ❌ Not found');
}

// 3. Check User PATH
console.log('\n User PATH Check:');
try {
  const userPath = execSync(
    'powershell -Command "[Environment]::GetEnvironmentVariable(\'PATH\', \'User\')"',
    { encoding: 'utf-8' }
  ).trim();
  
  if (userPath.includes(dwsDir)) {
    console.log('   Status: ✅ DWS directory found in User PATH');
  } else {
    console.log('   Status:  DWS directory NOT in User PATH');
    console.log('\n   This means addToPath() was not executed or failed.');
  }
} catch (error) {
  console.log('   Status: ️  Unable to check PATH');
}

// 4. Check System PATH
console.log('\n🔍 System PATH Check:');
try {
  const sysPath = execSync(
    'powershell -Command "[Environment]::GetEnvironmentVariable(\'PATH\', \'Machine\')"',
    { encoding: 'utf-8' }
  ).trim();
  
  if (sysPath.includes(dwsDir)) {
    console.log('   Status: ✅ DWS directory found in System PATH');
  } else {
    console.log('   Status: ❌ DWS directory NOT in System PATH');
  }
} catch {
  console.log('   Status: ⚠️  Unable to check System PATH');
}

// 5. Check current session PATH
console.log('\n Current Session PATH:');
const currentPath = process.env.PATH || '';
if (currentPath.includes(dwsDir)) {
  console.log('   Status: ✅ DWS directory in current session PATH');
} else {
  console.log('   Status: ❌ DWS directory NOT in current session PATH');
}

// 6. Solution
console.log('\n' + '='.repeat(60));
console.log('💡 Solution:\n');

if (!fs.existsSync(dwsExe)) {
  console.log(' DWS CLI is not installed!');
  console.log('   Run: node scripts/install-dws-cli-manual.mjs\n');
} else if (!currentPath.includes(dwsDir)) {
  console.log('⚠️  DWS CLI is installed but not in PATH.\n');
  console.log('   Manual fix (run in PowerShell):');
  console.log('   ```powershell');
  console.log('   $userPath = [Environment]::GetEnvironmentVariable(\'PATH\', \'User\')');
  console.log(`   $newPath = "$userPath;${dwsDir}"`);
  console.log('   [Environment]::SetEnvironmentVariable(\'PATH\', $newPath, \'User\')');
  console.log('   ```\n');
  console.log('   Then RESTART your terminal!');
} else {
  console.log('✅ DWS CLI is properly configured!');
  console.log('   Try: dws --version\n');
}

console.log('='.repeat(60));
