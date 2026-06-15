#!/usr/bin/env zx

import 'zx/globals';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const lockPath = join(ROOT, 'build', 'preinstalled-skills', '.preinstalled-lock.json');
const bundleScript = join(ROOT, 'scripts', 'bundle-preinstalled-skills.mjs');
const mergeScript = join(ROOT, 'scripts', 'merge-bundled-skills.mjs');
const devOpenClawDir = join(ROOT, 'node_modules', 'openclaw');
const prepareFailurePath = join(ROOT, 'build', '.preinstalled-skills-dev-failure.json');
const PREPARE_RETRY_COOLDOWN_MS = 30 * 60 * 1000;
const execFileAsync = promisify(execFile);

async function runNodeScript(scriptPath, args = []) {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [scriptPath, ...args],
    {
      cwd: ROOT,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
}

function getFailureSummary(error) {
  const details = String(error?.stderr || error?.message || error);
  const lines = details.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.findLast((line) => /^(fatal|error):/i.test(line))
    || lines.at(-1)
    || 'Unknown error';
}

function isPrepareCoolingDown() {
  if (process.env.CLAWX_FORCE_PREINSTALLED_SKILLS_PREPARE === '1') return false;
  if (!existsSync(prepareFailurePath)) return false;
  try {
    const failure = JSON.parse(readFileSync(prepareFailurePath, 'utf8'));
    return Date.now() - Number(failure.failedAt || 0) < PREPARE_RETRY_COOLDOWN_MS;
  } catch {
    return false;
  }
}

function recordPrepareFailure(error) {
  mkdirSync(dirname(prepareFailurePath), { recursive: true });
  writeFileSync(prepareFailurePath, `${JSON.stringify({
    failedAt: Date.now(),
    reason: getFailureSummary(error),
  }, null, 2)}\n`, 'utf8');
}

if (process.env.CLAWX_SKIP_PREINSTALLED_SKILLS_PREPARE === '1') {
  echo`Skipping preinstalled skills prepare (CLAWX_SKIP_PREINSTALLED_SKILLS_PREPARE=1).`;
  process.exit(0);
}

if (!existsSync(lockPath)) {
  if (isPrepareCoolingDown()) {
    echo`Preinstalled skills download is cooling down after a recent network failure; using local skills.`;
  } else {
    echo`Preinstalled skills bundle missing, preparing for dev startup...`;
    try {
      await runNodeScript(bundleScript);
      rmSync(prepareFailurePath, { force: true });
    } catch (error) {
      recordPrepareFailure(error);
      echo`Warning: preinstalled skills download failed; using local skills instead. ${getFailureSummary(error)}`;
    }
  }
} else {
  rmSync(prepareFailurePath, { force: true });
  echo`Preinstalled skills bundle already exists, skipping download.`;
}

if (existsSync(devOpenClawDir)) {
  try {
    await runNodeScript(mergeScript, [`--openclaw-dir=${devOpenClawDir}`]);
  } catch (error) {
    echo`Warning: failed to merge bundled skills into dev openclaw: ${error?.message || error}`;
  }
} else {
  echo`node_modules/openclaw not found; run pnpm install before dev.`;
}
