/**
 * Test: Save DingTalk OAuth token in different formats and test
 */

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const DWS_DIR = path.join(require('os').homedir(), '.dws');
const TOKEN_PATH = path.join(DWS_DIR, 'token');
const DWS_PATH = path.join(DWS_DIR, process.platform === 'win32' ? 'dws.exe' : 'dws');

// Get current token from file
const currentToken = fs.readFileSync(TOKEN_PATH, 'utf-8').trim();
const clientId = process.env.LYCLAW_DINGTALK_CLIENT_ID || process.env.DINGTALK_CLIENT_ID;
const clientSecret = process.env.LYCLAW_DINGTALK_CLIENT_SECRET || process.env.DINGTALK_CLIENT_SECRET;

console.log('🔍 Testing DWS token formats\n');
console.log('Current token:', currentToken.substring(0, 20) + '...');
console.log('ClientId:', clientId ? clientId.substring(0, 10) + '...' : 'NOT SET');
console.log('');

// Test different token formats
const testCases = [
  {
    name: 'Plain token (current)',
    token: currentToken,
  },
  {
    name: 'JSON with accessToken',
    token: JSON.stringify({ accessToken: currentToken }),
  },
  {
    name: 'JSON with token field',
    token: JSON.stringify({ token: currentToken }),
  },
  {
    name: 'JSON with auth data',
    token: JSON.stringify({
      accessToken: currentToken,
      clientId: clientId,
      expiresAt: Date.now() + 7200000,
    }),
  },
];

for (const testCase of testCases) {
  console.log(`🧪 Test: ${testCase.name}`);
  console.log(`Token: ${testCase.token.substring(0, 50)}...`);
  
  // Write token
  fs.writeFileSync(TOKEN_PATH, testCase.token, 'utf-8');
  
  // Test with dws command
  try {
    const output = execSync(`"${DWS_PATH}" contact user get-self --format json --client-id "${clientId}" --client-secret "${clientSecret}"`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env }
    });
    
    console.log('✅ SUCCESS!');
    const result = JSON.parse(output);
    if (result.success && result.user) {
      console.log(`   User: ${result.user.name || result.user.nick}`);
    } else {
      console.log('   Output:', output.substring(0, 100));
    }
    console.log('');
    console.log(' Found working format!');
    process.exit(0);
  } catch (error) {
    const errorMsg = (error.stdout || error.message).toString();
    if (errorMsg.includes('TOKEN_VERIFIED_FAILED')) {
      console.log('❌ Token verification failed\n');
    } else if (errorMsg.includes('未登录')) {
      console.log(' Not authenticated\n');
    } else {
      console.log('❌ Error:', errorMsg.substring(0, 100), '\n');
    }
  }
}

console.log(' None of the formats worked.');
console.log('   DWS CLI requires its own authentication flow.');
