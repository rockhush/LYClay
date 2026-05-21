/**
 * Manually set DWS token and test it
 * Usage: node scripts/set-dws-token.mjs <your-token>
 */

import { getDwsTokenPath, getDwsDir, ensureDwsEnvironmentInitialized } from '../electron/utils/dws-env-setup.ts';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

// Get token from command line
const token = process.argv[2];

if (!token) {
  console.log('❌ Usage: node scripts/set-dws-token.mjs <your-token>');
  console.log('');
  console.log('Example:');
  console.log('  node scripts/set-dws-token.mjs 55bee135e33736eda700aae12ef0c1c9');
  process.exit(1);
}

console.log('🔧 Setting DWS Token...\n');
console.log(`Token: ${token.substring(0, 10)}...${token.substring(token.length - 5)}`);
console.log(`Length: ${token.length} characters`);
console.log('');

// Initialize DWS environment
(async () => {
  await ensureDwsEnvironmentInitialized();
  
  const tokenPath = getDwsTokenPath();
  
  // Write token to file
  console.log(`Writing token to: ${tokenPath}`);
  fs.writeFileSync(tokenPath, token, { encoding: 'utf-8' });
  console.log('✅ Token written to file\n');
  
  // Also set environment variable
  process.env['DWS_ACCESS_TOKEN'] = token;
  console.log('✅ Environment variable DWS_ACCESS_TOKEN set\n');
  
  // Test the token
  console.log('🧪 Testing token...\n');
  
  const dwsPath = path.join(getDwsDir(), process.platform === 'win32' ? 'dws.exe' : 'dws');
  
  if (!fs.existsSync(dwsPath)) {
    console.log('❌ DWS CLI not installed!');
    process.exit(1);
  }
  
  // Test 1: dws auth status
  console.log('Test 1: dws auth status');
  try {
    const output = execSync(`"${dwsPath}" auth status --format json`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    console.log('✅ Success!');
    console.log(output);
  } catch (error) {
    console.log('❌ Failed:');
    console.log(error.stdout || error.message);
  }
  
  console.log('\n' + '='.repeat(60) + '\n');
  
  // Test 2: dws contact user get-self
  console.log('Test 2: dws contact user get-self --format json');
  try {
    const output = execSync(`"${dwsPath}" contact user get-self --format json`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    console.log('✅ Success!');
    console.log(output);
  } catch (error) {
    console.log('❌ Failed:');
    const errorMsg = error.stdout || error.message;
    console.log(errorMsg);
    
    // Check if it's the organization permission error
    if (errorMsg.includes('该组织尚未开启 CLI 数据访问权限')) {
      console.log('\n💡 This is an ORGANIZATION PERMISSION issue!');
      console.log('   Your token is correct, but your DingTalk organization has not enabled CLI access.');
      console.log('');
      console.log('   To fix:');
      console.log('   1. Contact your DingTalk organization admin');
      console.log('   2. Ask them to enable "CLI 数据访问权限"');
      console.log('   3. URL: https://open-dev.dingtalk.com/fe/old#/developerSettings');
    }
  }
})();
