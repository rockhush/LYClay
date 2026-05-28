#!/usr/bin/env node
/**
 * Verify bundled DWS CLI archives before packaging.
 */
import fs from 'node:fs';
import path from 'node:path';

const REQUIRED_ASSETS = {
  mac: [
    'resources/bin/darwin/dws-darwin-amd64.tar.gz',
    'resources/bin/darwin/dws-darwin-arm64.tar.gz',
  ],
  win: [
    'resources/bin/win/dws-windows-amd64.zip',
    'resources/bin/win/dws-windows-arm64.zip',
  ],
  linux: [
    'resources/bin/linux/dws-linux-amd64.tar.gz',
    'resources/bin/linux/dws-linux-arm64.tar.gz',
  ],
};

function getPlatforms() {
  const platformArg = process.argv.find((arg) => arg.startsWith('--platform='))?.split('=')[1];
  if (platformArg) return [platformArg];
  return Object.keys(REQUIRED_ASSETS);
}

let missing = [];
for (const platform of getPlatforms()) {
  const assets = REQUIRED_ASSETS[platform];
  if (!assets) {
    console.error(`[verify-dws-bundles] Unknown platform: ${platform}`);
    process.exitCode = 1;
    continue;
  }

  for (const asset of assets) {
    const absolutePath = path.resolve(asset);
    if (!fs.existsSync(absolutePath)) {
      missing.push(asset);
      continue;
    }
    const stat = fs.statSync(absolutePath);
    if (stat.size <= 0) {
      missing.push(`${asset} (empty)`);
    }
  }
}

if (missing.length > 0) {
  console.error('[verify-dws-bundles] Missing required DWS archives:');
  for (const asset of missing) {
    console.error(`  - ${asset}`);
  }
  process.exit(1);
}

console.log('[verify-dws-bundles] DWS archives verified.');
