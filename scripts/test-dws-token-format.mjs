/**
 * Test what token format DWS CLI actually expects
 */

import { getDwsTokenPath, getDwsDir } from '../electron/utils/dws-env-setup.ts';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

console.log('🔍 DWS CLI Token Format Investigation\n');

const dwsPath = path.join(getDwsDir(), process.platform === 'win32' ? 'dws.exe' : 'dws');
const tokenPath = getDwsTokenPath();

// Get current token
const currentToken = fs.existsSync(tokenPath) 
  ? fs.readFileSync(tokenPath, 'utf-8').trim() 
  : null;

console.log(`Current token: ${currentToken ? currentToken.substring(0, 20) + '...' : 'NOT SET'}`);
console.log(`Token length: ${currentToken?.length || 0}`);
console.log('');

// Test 1: Try with --token parameter directly
console.log('🧪 Test 1: Using --token parameter');
console.log('   Command: dws contact user get-self --token <your-token> --format json\n');

if (currentToken) {
  try {
    const output = execSync(`"${dwsPath}" contact user get-self --token "${currentToken}" --format json`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    console.log('✅ Success with --token parameter!');
    console.log(output);
  } catch (error) {
    console.log('❌ Failed with --token parameter:');
    console.log(error.stdout || error.message);
  }
}

console.log('\n' + '='.repeat(60) + '\n');

// Test 2: Try reading from token file
console.log('🧪 Test 2: Reading from token file');
console.log(`   Token file: ${tokenPath}`);

if (currentToken) {
  // Remove env var to force reading from file
  const cleanEnv = { ...process.env };
  delete cleanEnv['DWS_ACCESS_TOKEN'];
  
  try {
    const output = execSync(`"${dwsPath}" contact user get-self --format json`, {
      encoding: 'utf-8',
      env: cleanEnv,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    console.log('✅ Success reading from token file!');
    console.log(output);
  } catch (error) {
    console.log('❌ Failed reading from token file:');
    console.log(error.stdout || error.message);
  }
}

console.log('\n' + '='.repeat(60) + '\n');

// Test 3: Check what dws auth status says
console.log('🧪 Test 3: dws auth status');

try {
  const output = execSync(`"${dwsPath}" auth status --format json`, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe']
  });
  console.log('✅ Auth status:');
  console.log(output);
} catch (error) {
  console.log('❌ Auth status failed:');
  console.log(error.stdout || error.message);
}

console.log('\n' + '='.repeat(60) + '\n');

// Test 4: Check dws help for auth
console.log('🧪 Test 4: dws auth --help');

try {
  const output = execSync(`"${dwsPath}" auth --help`, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe']
  });
  console.log(output);
} catch (error) {
  console.log(error.stdout || error.message);
}
