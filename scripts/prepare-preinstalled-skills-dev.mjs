#!/usr/bin/env zx

import 'zx/globals';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const lockPath = join(ROOT, 'build', 'preinstalled-skills', '.preinstalled-lock.json');
const bundleScript = join(ROOT, 'scripts', 'bundle-preinstalled-skills.mjs');
const mergeScript = join(ROOT, 'scripts', 'merge-bundled-skills.mjs');
const devOpenClawDir = join(ROOT, 'node_modules', 'openclaw');

if (process.env.CLAWX_SKIP_PREINSTALLED_SKILLS_PREPARE === '1') {
  echo`Skipping preinstalled skills prepare (CLAWX_SKIP_PREINSTALLED_SKILLS_PREPARE=1).`;
  process.exit(0);
}

if (!existsSync(lockPath)) {
  echo`Preinstalled skills bundle missing, preparing for dev startup...`;
  try {
    await $`zx ${bundleScript}`;
  } catch (error) {
    echo`Warning: failed to prepare preinstalled skills for dev startup: ${error?.message || error}`;
  }
} else {
  echo`Preinstalled skills bundle already exists, skipping download.`;
}

if (existsSync(devOpenClawDir)) {
  try {
    await $`node ${mergeScript} --openclaw-dir=${devOpenClawDir}`;
  } catch (error) {
    echo`Warning: failed to merge bundled skills into dev openclaw: ${error?.message || error}`;
  }
} else {
  echo`node_modules/openclaw not found; run pnpm install before dev.`;
}
