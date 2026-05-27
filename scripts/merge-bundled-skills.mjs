#!/usr/bin/env zx

/**
 * Merge LYClaw built-in skill trees into openclaw/skills/ (bundled layout).
 *
 * Sources (in order; later sources do not overwrite existing slugs):
 *   1. resources/builtin-skills/
 *   2. build/preinstalled-skills/ or resources/preinstalled-skills/
 *
 * Usage:
 *   zx scripts/merge-bundled-skills.mjs
 *   zx scripts/merge-bundled-skills.mjs --openclaw-dir=node_modules/openclaw
 */

import 'zx/globals';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function readArgValue(name) {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return '';
}

function listSkillSlugs(root) {
  if (!existsSync(root)) return [];
  const slugs = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = join(root, entry.name, 'SKILL.md');
    if (existsSync(manifest)) slugs.push(entry.name);
  }
  return slugs;
}

function mergeSourceIntoTarget({ sourceRoot, targetSkillsRoot, label }) {
  if (!existsSync(sourceRoot)) {
    echo`   [merge-skills] Skip ${label}: source not found (${sourceRoot})`;
    return { copied: [], skipped: [] };
  }

  const copied = [];
  const skipped = [];
  for (const slug of listSkillSlugs(sourceRoot)) {
    const sourceDir = join(sourceRoot, slug);
    const targetDir = join(targetSkillsRoot, slug);
    const targetManifest = join(targetDir, 'SKILL.md');
    if (existsSync(targetManifest)) {
      skipped.push(slug);
      continue;
    }
    fs.mkdirSync(targetDir, { recursive: true });
    fs.cpSync(sourceDir, targetDir, { recursive: true, dereference: true });
    copied.push(slug);
  }
  return { copied, skipped };
}

const openclawDir = readArgValue('--openclaw-dir') || join(ROOT, 'build', 'openclaw');
const targetSkillsRoot = join(openclawDir, 'skills');

if (!existsSync(openclawDir)) {
  echo`❌ openclaw dir not found: ${openclawDir}`;
  process.exit(1);
}

fs.mkdirSync(targetSkillsRoot, { recursive: true });

const preinstalledCandidates = [
  join(ROOT, 'build', 'preinstalled-skills'),
  join(ROOT, 'resources', 'preinstalled-skills'),
];
const preinstalledRoot = preinstalledCandidates.find((p) => existsSync(p)) || preinstalledCandidates[0];

echo`📚 Merging bundled skills into ${targetSkillsRoot}`;

const builtinResult = mergeSourceIntoTarget({
  sourceRoot: join(ROOT, 'resources', 'builtin-skills'),
  targetSkillsRoot,
  label: 'builtin-skills',
});
const preinstalledResult = mergeSourceIntoTarget({
  sourceRoot: preinstalledRoot,
  targetSkillsRoot,
  label: 'preinstalled-skills',
});

const allCopied = [...builtinResult.copied, ...preinstalledResult.copied];
const allSkipped = [...new Set([...builtinResult.skipped, ...preinstalledResult.skipped])];

if (allCopied.length > 0) {
  echo`   ✓ Copied: ${allCopied.join(', ')}`;
}
if (allSkipped.length > 0) {
  echo`   · Already present (kept openclaw copy): ${allSkipped.join(', ')}`;
}
if (allCopied.length === 0 && allSkipped.length === 0) {
  echo`   (no skill sources to merge)`;
}

const skillCount = listSkillSlugs(targetSkillsRoot).length;
echo`   Total skills in bundle: ${skillCount}`;
