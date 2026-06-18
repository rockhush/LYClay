#!/usr/bin/env node
/**
 * Patch OpenClaw's BROWSER_TOOL_MODEL_HINT to allow retries on transient errors.
 *
 * The original hint ("Do NOT retry the browser tool — it will keep failing")
 * causes models to permanently refuse browser usage after a single transient error.
 *
 * This runs as postinstall to patch node_modules for dev mode.
 * Production builds are separately patched in bundle-openclaw.mjs.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { applyOpenClawOpenAITransportPatches, hasOpenClawOpenAITransportPatches } from './openclaw-transport-patches.mjs';
import { applyOpenClawUsageStreamingPatches, hasOpenClawUsageStreamingPatches } from './openclaw-usage-patches.mjs';

const BROWSER_HINT_REPLACEMENTS = [
  [
    'Do NOT retry the browser tool \u2014 it will keep failing. Use an alternative approach or inform the user that the browser is currently unavailable.',
    'If this was a transient error (timeout, network), you may retry once. If the same error persists after retry, try an alternative approach and let the user know.',
  ],
  [
    'Do NOT retry the browser tool.',
    'You may retry once if this was a transient error.',
  ],
];

const PRICING_BOOTSTRAP_REPLACEMENTS = [
  [
    [
      'function startGatewayModelPricingRefresh(params) {',
      '\tlet stopped = false;',
      '\tqueueMicrotask(() => {',
      '\t\tif (stopped) return;',
      '\t\trefreshGatewayModelPricingCache(params).catch((error) => {',
      '\t\t\tlog.warn(`pricing bootstrap failed: ${String(error)}`);',
      '\t\t});',
      '\t});',
      '\treturn () => {',
      '\t\tstopped = true;',
      '\t\tclearRefreshTimer();',
      '\t};',
      '}',
    ].join('\n'),
    [
      'function startGatewayModelPricingRefresh(params) {',
      '\tlet stopped = false;',
      '\trefreshTimer = setTimeout(() => {',
      '\t\trefreshTimer = null;',
      '\t\tif (stopped) return;',
      '\t\trefreshGatewayModelPricingCache(params).catch((error) => {',
      '\t\t\tlog.warn(`pricing bootstrap failed: ${String(error)}`);',
      '\t\t});',
      '\t}, 9e4);',
      '\treturn () => {',
      '\t\tstopped = true;',
      '\t\tclearRefreshTimer();',
      '\t};',
      '}',
    ].join('\n'),
  ],
];

const CHANNEL_PREWARM_REPLACEMENTS = [
  [
    [
      '\t\tif (!skipChannels) try {',
      '\t\t\tawait prewarmConfiguredPrimaryModel({',
      '\t\t\t\tcfg: params.cfg,',
      '\t\t\t\tlog: params.log',
      '\t\t\t});',
      '\t\t\tawait params.startChannels();',
      '\t\t} catch (err) {',
    ].join('\n'),
    [
      '\t\tif (!skipChannels) try {',
      '\t\t\tsetTimeout(() => {',
      '\t\t\t\tprewarmConfiguredPrimaryModel({',
      '\t\t\t\t\tcfg: params.cfg,',
      '\t\t\t\t\tlog: params.log',
      '\t\t\t\t}).catch((err) => {',
      '\t\t\t\t\tparams.log.warn(`startup model warmup failed: ${String(err)}`);',
      '\t\t\t\t});',
      '\t\t\t}, 3e4);',
      '\t\t\tawait params.startChannels();',
      '\t\t} catch (err) {',
    ].join('\n'),
  ],
];

const LY_AUTO_SESSION_HEADER_REPLACEMENTS = [
  [
    [
      'function createOpenAICompletionsClient(model, context, apiKey, optionHeaders) {',
      '\tconst clientConfig = buildOpenAICompletionsClientConfig(model, context, optionHeaders);',
    ].join('\n'),
    [
      'function createOpenAICompletionsClient(model, context, apiKey, optionHeaders, turnHeaders) {',
      '\tconst clientConfig = buildOpenAICompletionsClientConfig(model, context, optionHeaders, turnHeaders);',
    ].join('\n'),
  ],
  [
    [
      'function buildOpenAICompletionsClientConfig(model, context, optionHeaders) {',
      '\tconst headers = buildOpenAIClientHeaders(model, context, optionHeaders);',
    ].join('\n'),
    [
      'function buildOpenAICompletionsClientConfig(model, context, optionHeaders, turnHeaders) {',
      '\tconst headers = buildOpenAIClientHeaders(model, context, optionHeaders, turnHeaders);',
    ].join('\n'),
  ],
  [
    'const client = createOpenAICompletionsClient(model, context, options?.apiKey || getEnvApiKey(model.provider) || "", options?.headers);',
    'const client = createOpenAICompletionsClient(model, context, options?.apiKey || getEnvApiKey(model.provider) || "", options?.headers, (() => { const sid = options?.sessionId; resolveProviderTransportTurnState(model, { sessionId: sid, turnId: randomUUID(), attempt: 1, transport: "stream" }); return model.provider === "ly-auto" && sid ? { "X-LYClaw-Session-Id": sid } : {}; })());',
  ],
  [
    'providerId: params.model.provider\n\t\t});',
    'providerId: params.model.provider,\n\t\tsessionId: params.sessionId\n\t\t});',
  ],
  [
    'providerId: params.model.provider,\n\t\ttransformContext:',
    'providerId: params.model.provider,\n\t\tsessionId: params.sessionId,\n\t\ttransformContext:',
  ],
];

const LY_AUTO_PROMPT_CACHE_REPLACEMENTS = [
  [
    'if (compat.supportsPromptCacheKey && cacheRetention !== "none" && options?.sessionId) params.prompt_cache_key = options.sessionId;',
    'if ((compat.supportsPromptCacheKey || model.provider === "ly-auto") && cacheRetention !== "none" && options?.sessionId) params.prompt_cache_key = options.sessionId;',
  ],
];

const REPLACEMENTS = [
  ...BROWSER_HINT_REPLACEMENTS,
  ...PRICING_BOOTSTRAP_REPLACEMENTS,
  ...CHANNEL_PREWARM_REPLACEMENTS,
  ...LY_AUTO_SESSION_HEADER_REPLACEMENTS,
  ...LY_AUTO_PROMPT_CACHE_REPLACEMENTS,
];

const distDir = join(process.cwd(), 'node_modules', 'openclaw', 'dist');

let patchedCount = 0;
if (!existsSync(distDir)) {
  console.warn(`[patch-browser-hint] Skip: ${distDir} not found (run pnpm install)`);
} else {
try {
  for (const file of readdirSync(distDir)) {
    if (!file.endsWith('.js')) continue;
    const filePath = join(distDir, file);
    let content = readFileSync(filePath, 'utf-8');
    let changed = false;
    for (const [search, replace] of REPLACEMENTS) {
      if (content.includes(search)) {
        content = content.replaceAll(search, replace);
        changed = true;
      }
    }
    if (changed) {
      writeFileSync(filePath, content, 'utf-8');
      console.log(`[patch-browser-hint] Patched: ${file}`);
      patchedCount++;
    }

    if (file.startsWith('openai-transport-stream-')) {
      let transportContent = content;
      let transportChanged = false;

      const usageResult = applyOpenClawUsageStreamingPatches(transportContent);
      if (usageResult.patched) {
        transportContent = usageResult.source;
        transportChanged = true;
      }

      const transportResult = applyOpenClawOpenAITransportPatches(transportContent);
      if (transportResult.patched) {
        transportContent = transportResult.source;
        transportChanged = true;
      }

      if (transportChanged) {
        writeFileSync(filePath, transportContent, 'utf-8');
        console.log(`[patch-browser-hint] Patched OpenAI transport (${file}): usage=${hasOpenClawUsageStreamingPatches(transportContent)}, session=${hasOpenClawOpenAITransportPatches(transportContent)}`);
        patchedCount++;
      }
    }
  }
} catch (err) {
  console.warn(`[patch-browser-hint] Failed: ${err instanceof Error ? err.message : err}`);
}
}

if (patchedCount > 0) {
  console.log(`[patch-browser-hint] Done. Patched ${patchedCount} file(s).`);
} else if (existsSync(distDir)) {
  console.log('[patch-browser-hint] No changes (already patched or patterns not found).');
  console.log('[patch-browser-hint] Run: node scripts/patch-openclaw-dev.mjs  for detailed status.');
}
