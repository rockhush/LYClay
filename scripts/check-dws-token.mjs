/**
 * Check current DWS token and validate it
 */

const { getDwsTokenPath, getDwsDir } = require('../electron/utils/dws-env-setup');
const fs = require('fs');
const path = require('path');

console.log('🔍 Checking DWS Token...\n');

// 1. Check token file
const tokenPath = getDwsTokenPath();
console.log(`Token file path: ${tokenPath}`);

if (!fs.existsSync(tokenPath)) {
  console.log('❌ Token file does not exist!');
  console.log('   Please login first: Settings > DingTalk > Login');
  process.exit(1);
}

const token = fs.readFileSync(tokenPath, 'utf-8').trim();
console.log(`✅ Token file exists`);
console.log(`Token length: ${token.length} characters`);
console.log(`Token preview: ${token.substring(0, 10)}...${token.substring(token.length - 5)}`);
console.log('');

// 2. Check environment variable
const envToken = process.env['DWS_ACCESS_TOKEN'];
console.log('Environment variable DWS_ACCESS_TOKEN:');
if (envToken) {
  console.log(`  ✅ Set: ${envToken.substring(0, 10)}...${envToken.substring(envToken.length - 5)}`);
  console.log(`  ${envToken === token ? '✅ Matches file token' : '❌ Different from file token!'}`);
} else {
  console.log('  ❌ Not set');
}
console.log('');

// 3. Check dws CLI
const dwsPath = path.join(getDwsDir(), process.platform === 'win32' ? 'dws.exe' : 'dws');
console.log(`DWS CLI path: ${dwsPath}`);

if (!fs.existsSync(dwsPath)) {
  console.log('❌ DWS CLI not installed!');
  console.log('   Please restart ClawX to install DWS CLI');
  process.exit(1);
}

console.log('✅ DWS CLI exists');
console.log('');

// 4. Test token with dws auth status
console.log('🧪 Testing token with: dws auth status\n');

const { execSync } = require('child_process');

try {
  const output = execSync(`"${dwsPath}" auth status --format json`, {
    encoding: 'utf-8',
    env: { ...process.env, DWS_ACCESS_TOKEN: token },
  });
  
  console.log('✅ Token is valid!');
  console.log(output);
} catch (error) {
  console.log('❌ Token validation failed:');
  console.log(error.stdout || error.message);
  console.log('');
  console.log('💡 Possible reasons:');
  console.log('   1. Token has expired (please re-login)');
  console.log('   2. Organization has not enabled CLI data access permission');
  console.log('   3. Token is invalid or corrupted');
  console.log('');
  console.log('🔧 How to fix:');
  console.log('   - Contact your organization admin to enable "CLI 数据访问权限"');
  console.log('   - Visit: https://open-dev.dingtalk.com/fe/old#/developerSettings');
}
