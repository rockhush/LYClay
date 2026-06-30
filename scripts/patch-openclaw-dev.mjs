#!/usr/bin/env node
/**
 * Patch OpenClaw dist for dev (node_modules/openclaw).
 * Always prints a status summary — silent success was confusing.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyOpenClawOpenAITransportPatches, hasOpenClawOpenAITransportPatches } from './openclaw-transport-patches.mjs';
import { applyOpenClawSilentReplyPatches, hasOpenClawSilentReplyPatches } from './openclaw-silent-reply-patches.mjs';
import { applyOpenClawUsageStreamingPatches, applyPiAiUsageStreamingPatches, hasOpenClawUsageStreamingPatches, hasPiAiUsageStreamingPatches } from './openclaw-usage-patches.mjs';
import { inspectOpenClawDigitalEmployeeIsolation } from './openclaw-digital-employee-isolation-check.mjs';

const ROOT = process.cwd();
const openclawCandidates = [
  join(ROOT, 'node_modules', 'openclaw'),
  join(ROOT, 'build', 'openclaw'),
];

function resolveOpenClawDir() {
  for (const candidate of openclawCandidates) {
    if (!existsSync(candidate)) continue;
    try {
      const resolved = realpathSync(candidate);
      if (existsSync(join(resolved, 'package.json'))) return resolved;
    } catch {
      if (existsSync(join(candidate, 'package.json'))) return candidate;
    }
  }
  return null;
}

function patchTransportFile(filePath, fileName) {
  let content = readFileSync(filePath, 'utf8');
  const beforeUsage = hasOpenClawUsageStreamingPatches(content);
  const beforeSession = hasOpenClawOpenAITransportPatches(content);

  const usageResult = applyOpenClawUsageStreamingPatches(content);
  content = usageResult.source;

  const sessionResult = applyOpenClawOpenAITransportPatches(content);
  content = sessionResult.source;

  const afterUsage = hasOpenClawUsageStreamingPatches(content);
  const afterSession = hasOpenClawOpenAITransportPatches(content);
  const changed = usageResult.patched || sessionResult.patched;

  if (changed) {
    writeFileSync(filePath, content, 'utf8');
  }

  return {
    fileName,
    changed,
    usage: afterUsage ? (usageResult.patched ? 'applied' : 'already') : 'missing',
    session: afterSession ? (sessionResult.patched ? 'applied' : 'already') : 'missing',
    hasIncludeUsage: content.includes('include_usage'),
    hadUsageBefore: beforeUsage,
    hadSessionBefore: beforeSession,
  };
}

function main() {
  const openclawDir = resolveOpenClawDir();
  console.log('[patch-openclaw-dev] OpenClaw patch runner');

  if (!openclawDir) {
    console.error('[patch-openclaw-dev] ERROR: openclaw not found.');
    console.error('  Tried:');
    for (const candidate of openclawCandidates) {
      console.error(`    - ${candidate}`);
    }
    console.error('  Run: pnpm install');
    process.exit(1);
  }

  console.log(`[patch-openclaw-dev] Using: ${openclawDir}`);

  const distDir = join(openclawDir, 'dist');
  if (!existsSync(distDir)) {
    console.error(`[patch-openclaw-dev] ERROR: dist/ missing at ${distDir}`);
    process.exit(1);
  }

  const transportFiles = readdirSync(distDir).filter((name) =>
    name.endsWith('.js') && (
      name.startsWith('openai-transport-stream-')
      || name.includes('openai-transport')
    ),
  );

  if (transportFiles.length === 0) {
    console.warn('[patch-openclaw-dev] No openai-transport-stream-*.js — scanning dist for usage gate...');
    const fallback = [];
    for (const name of readdirSync(distDir)) {
      if (!name.endsWith('.js')) continue;
      const content = readFileSync(join(distDir, name), 'utf8');
      if (content.includes('supportsUsageInStreaming') && content.includes('stream_options')) {
        fallback.push(name);
      }
    }
    transportFiles.push(...fallback);
  }

  if (transportFiles.length === 0) {
    console.error('[patch-openclaw-dev] ERROR: no transport bundle with supportsUsageInStreaming found.');
    process.exit(1);
  }

  let changedCount = 0;
  const patchedNames = new Set(transportFiles);
  for (const fileName of transportFiles) {
    const result = patchTransportFile(join(distDir, fileName), fileName);
    console.log(
      `[patch-openclaw-dev] ${fileName}: usage=${result.usage}, session=${result.session}, include_usage=${result.hasIncludeUsage ? 'yes' : 'no'}${result.changed ? ' (written)' : ''}`,
    );
    if (result.changed) changedCount += 1;
  }

  for (const name of readdirSync(distDir)) {
    if (!name.endsWith('.js') || patchedNames.has(name)) continue;
    const filePath = join(distDir, name);
    const content = readFileSync(filePath, 'utf8');
    if (!content.includes('supportsUsageInStreaming') || !content.includes('stream_options')) continue;
    const usageResult = applyOpenClawUsageStreamingPatches(content);
    if (!usageResult.patched) continue;
    writeFileSync(filePath, usageResult.source, 'utf8');
    patchedNames.add(name);
    changedCount += 1;
    console.log(`[patch-openclaw-dev] ${name}: usage=applied (written)`);
  }

  console.log(`[patch-openclaw-dev] Done. ${changedCount} file(s) updated, ${transportFiles.length} checked.`);

  const piAiCandidates = [
    join(openclawDir, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers', 'openai-completions.js'),
    join(ROOT, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers', 'openai-completions.js'),
  ];
  let piAiPatched = false;
  for (const piAiPath of piAiCandidates) {
    if (!existsSync(piAiPath)) continue;
    let piAiSource = readFileSync(piAiPath, 'utf8');
    const piAiResult = applyPiAiUsageStreamingPatches(piAiSource);
    if (piAiResult.patched) {
      writeFileSync(piAiPath, piAiResult.source, 'utf8');
      console.log(`[patch-openclaw-dev] ${piAiPath}: usage=applied (written)`);
      changedCount += 1;
      piAiPatched = true;
    } else {
      console.log(`[patch-openclaw-dev] ${piAiPath}: usage=${hasPiAiUsageStreamingPatches(piAiSource) ? 'already' : 'missing'}`);
      piAiPatched = true;
    }
    break;
  }
  if (!piAiPatched) {
    console.warn('[patch-openclaw-dev] pi-ai openai-completions.js not found in openclaw or workspace node_modules');
  }

  let silentReplyPatched = 0;
  for (const name of readdirSync(distDir)) {
    if (!name.endsWith('.js')) continue;
    const filePath = join(distDir, name);
    const content = readFileSync(filePath, 'utf8');
    if (!content.includes('function normalizeAssistantReplayTextContent(message, replayContent)')) continue;
    const silentReplyResult = applyOpenClawSilentReplyPatches(content);
    if (!silentReplyResult.patched) {
      console.log(
        `[patch-openclaw-dev] ${name}: silent-reply=${hasOpenClawSilentReplyPatches(content) ? 'already' : 'missing'}`,
      );
      continue;
    }
    writeFileSync(filePath, silentReplyResult.source, 'utf8');
    silentReplyPatched += 1;
    changedCount += 1;
    console.log(`[patch-openclaw-dev] ${name}: silent-reply=applied (written)`);
  }
  if (silentReplyPatched === 0) {
    console.warn('[patch-openclaw-dev] WARN: no selection bundle received silent-reply patch.');
  }

  const isolationStatus = inspectOpenClawDigitalEmployeeIsolation(openclawDir, { fs: { existsSync, readdirSync, readFileSync }, path: { join } });
  console.log(`[patch-openclaw-dev] digital employee isolated skills/MCP=${isolationStatus.ok ? 'ok' : 'missing'}`);
  if (!isolationStatus.ok) {
    for (const item of isolationStatus.missing) {
      console.error(`[patch-openclaw-dev] missing: ${item}`);
    }
    process.exit(1);
  }

  if (changedCount === 0) {
    console.warn('[patch-openclaw-dev] WARN: no files updated. If usage is still zero, openclaw dist layout may have changed.');
  }
}

main();
