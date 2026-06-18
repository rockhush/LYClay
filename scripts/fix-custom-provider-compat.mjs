#!/usr/bin/env node
/**
 * One-shot fix: add supportsUsageInStreaming compat to custom/ollama openai-completions
 * entries in ~/.openclaw/agents/*/agent/models.json
 *
 * Custom vLLM providers use OpenClaw boundary-aware transport, which only sends
 * stream_options.include_usage when model.compat.supportsUsageInStreaming is true.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const COMPAT = {
  supportsUsageInStreaming: true,
  supportsPromptCacheKey: false,
};

function mergeCompat(model) {
  const existing = model.compat && typeof model.compat === 'object' && !Array.isArray(model.compat)
    ? model.compat
    : {};
  return {
    ...model,
    compat: { ...existing, ...COMPAT },
  };
}

function patchProviderEntry(provider) {
  if (!provider || typeof provider !== 'object') return { entry: provider, changed: false };
  if (provider.api !== 'openai-completions') return { entry: provider, changed: false };
  if (!Array.isArray(provider.models) || provider.models.length === 0) {
    return { entry: provider, changed: false };
  }

  let changed = false;
  const models = provider.models.map((model) => {
    if (!model || typeof model !== 'object') return model;
    const needsCompat = !model.compat?.supportsUsageInStreaming;
    if (!needsCompat) return model;
    changed = true;
    return mergeCompat(model);
  });

  return {
    entry: changed ? { ...provider, models } : provider,
    changed,
  };
}

function patchModelsJson(filePath) {
  let data;
  try {
    data = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.warn(`[fix-custom-provider-compat] skip corrupt ${filePath}: ${err}`);
    return false;
  }

  const providers = data?.providers;
  if (!providers || typeof providers !== 'object') return false;

  let changed = false;
  const nextProviders = { ...providers };
  for (const [key, entry] of Object.entries(providers)) {
    if (!key.startsWith('custom-') && !key.startsWith('ollama-')) continue;
    const result = patchProviderEntry(entry);
    if (result.changed) {
      nextProviders[key] = result.entry;
      changed = true;
      console.log(`[fix-custom-provider-compat] ${filePath}: patched ${key}`);
    }
  }

  if (!changed) return false;
  writeFileSync(filePath, `${JSON.stringify({ ...data, providers: nextProviders }, null, 2)}\n`, 'utf8');
  return true;
}

function main() {
  const agentsRoot = join(homedir(), '.openclaw', 'agents');
  if (!existsSync(agentsRoot)) {
    console.error('[fix-custom-provider-compat] No ~/.openclaw/agents directory found.');
    process.exit(1);
  }

  let patchedFiles = 0;
  for (const agentId of readdirSync(agentsRoot)) {
    const modelsPath = join(agentsRoot, agentId, 'agent', 'models.json');
    if (!existsSync(modelsPath)) continue;
    if (patchModelsJson(modelsPath)) patchedFiles += 1;
  }

  if (patchedFiles === 0) {
    console.log('[fix-custom-provider-compat] No changes needed (compat already present or no custom providers).');
  } else {
    console.log(`[fix-custom-provider-compat] Updated ${patchedFiles} models.json file(s). Restart Gateway and start a NEW session.`);
  }
}

main();
