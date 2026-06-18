/**
 * Replay context.compiled turns from a trajectory file against a vLLM-compatible
 * chat/completions endpoint to verify prefix-cache behavior with real HTTP.
 *
 * Usage:
 *   node scripts/replay-trajectory-to-vllm.mjs <trajectory.jsonl> --provider custom-xxx
 *   node scripts/replay-trajectory-to-vllm.mjs <trajectory.jsonl> --base-url http://host/v1 --api-key KEY --model MiniMax-M2.7
 *
 * Options:
 *   --provider <id>     Read baseUrl/apiKey/model from ~/.openclaw/openclaw.json
 *   --base-url <url>    Override provider base URL (must include /v1 if needed)
 *   --api-key <key>     Override API key
 *   --model <id>        Override model id
 *   --turns <n>         Replay last N compiled turns (default: 2)
 *   --content raw|text  Send message content as logged (raw) or flatten text blocks (default: text)
 *   --max-tokens <n>    max_tokens for probe requests (default: 1)
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function parseArgs(argv) {
  const positional = [];
  const opts = {
    provider: undefined,
    baseUrl: undefined,
    apiKey: undefined,
    model: undefined,
    turns: 2,
    content: 'text',
    maxTokens: 1,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--provider') opts.provider = argv[++i];
    else if (arg === '--base-url') opts.baseUrl = argv[++i];
    else if (arg === '--api-key') opts.apiKey = argv[++i];
    else if (arg === '--model') opts.model = argv[++i];
    else if (arg === '--turns') opts.turns = Number(argv[++i]);
    else if (arg === '--content') opts.content = argv[++i];
    else if (arg === '--max-tokens') opts.maxTokens = Number(argv[++i]);
    else if (!arg.startsWith('-')) positional.push(arg);
  }
  return { file: positional[0], opts };
}

function flattenContent(content, mode) {
  if (typeof content !== 'string') return JSON.stringify(content ?? '');
  if (mode === 'raw') return content;
  if (!content.startsWith('[')) return content;
  try {
    const blocks = JSON.parse(content);
    if (!Array.isArray(blocks)) return content;
    return blocks
      .map((block) => {
        if (!block || typeof block !== 'object') return '';
        if (typeof block.text === 'string') return block.text;
        if (typeof block.content === 'string') return block.content;
        return '';
      })
      .join('');
  } catch {
    return content;
  }
}

function loadCompiledTurns(file) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  const turns = [];
  for (const line of lines) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed.type !== 'context.compiled') continue;
    const data = parsed.data || {};
    turns.push({
      runId: parsed.runId,
      provider: parsed.provider,
      modelId: parsed.modelId,
      systemPrompt: typeof data.systemPrompt === 'string'
        ? data.systemPrompt
        : JSON.stringify(data.systemPrompt ?? ''),
      messages: Array.isArray(data.messages) ? data.messages : [],
    });
  }
  return turns;
}

function readProviderConfig(providerId) {
  const configPath = join(homedir(), '.openclaw', 'openclaw.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const provider = config?.models?.providers?.[providerId];
  if (!provider) {
    throw new Error(`Provider "${providerId}" not found in ${configPath}`);
  }
  const models = Array.isArray(provider.models) ? provider.models : [];
  const firstModel = models[0];
  const modelId = typeof firstModel === 'string'
    ? firstModel
    : (typeof firstModel?.id === 'string' ? firstModel.id : undefined);
  return {
    baseUrl: provider.baseUrl ?? provider.baseURL,
    apiKey: provider.apiKey ?? provider.api_key ?? 'EMPTY',
    model: modelId,
  };
}

function buildChatPayload(turn, model, contentMode, maxTokens) {
  const messages = [{ role: 'system', content: turn.systemPrompt }];
  for (const message of turn.messages) {
    messages.push({
      role: message.role,
      content: flattenContent(message.content, contentMode),
    });
  }
  return {
    model,
    messages,
    max_tokens: maxTokens,
    stream: false,
  };
}

function pickUsage(body) {
  const usage = body?.usage ?? {};
  const details = usage.prompt_tokens_details;
  const cachedFromDetails = details && typeof details === 'object' && !Array.isArray(details)
    ? details.cached_tokens
    : undefined;
  return {
    prompt_tokens: usage.prompt_tokens ?? usage.input ?? null,
    completion_tokens: usage.completion_tokens ?? usage.output ?? null,
    total_tokens: usage.total_tokens ?? usage.total ?? null,
    cached_tokens:
      cachedFromDetails
      ?? usage.cache_read
      ?? usage.cacheRead
      ?? usage.prompt_cache_hit_tokens
      ?? null,
    cache_write: usage.cache_write ?? usage.cacheWrite ?? usage.prompt_cache_miss_tokens ?? null,
  };
}

async function postChat(baseUrl, apiKey, payload) {
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${url}\n${text.slice(0, 800)}`);
  }
  return body;
}

const { file, opts } = parseArgs(process.argv.slice(2));
if (!file) {
  console.error('Usage: node scripts/replay-trajectory-to-vllm.mjs <trajectory.jsonl> --provider <id>');
  process.exit(1);
}

const compiledTurns = loadCompiledTurns(file);
if (compiledTurns.length === 0) {
  console.error('No context.compiled events in trajectory file.');
  process.exit(1);
}

let baseUrl = opts.baseUrl;
let apiKey = opts.apiKey;
let model = opts.model;

if (opts.provider) {
  const cfg = readProviderConfig(opts.provider);
  baseUrl = baseUrl ?? cfg.baseUrl;
  apiKey = apiKey ?? cfg.apiKey;
  model = model ?? cfg.model;
}

if (!baseUrl || !model) {
  console.error('Missing --base-url/--model or --provider with valid openclaw.json config.');
  process.exit(1);
}

apiKey = apiKey ?? 'EMPTY';
const replayTurns = compiledTurns.slice(-Math.max(1, opts.turns));

console.log(`Replaying ${replayTurns.length} turn(s) to ${baseUrl}`);
console.log(`model=${model} content=${opts.content} max_tokens=${opts.maxTokens}\n`);

const results = [];
for (const [index, turn] of replayTurns.entries()) {
  const payload = buildChatPayload(turn, model, opts.content, opts.maxTokens);
  console.log(`--- HTTP POST turn ${index + 1}/${replayTurns.length} (${turn.runId}) ---`);
  console.log(`messages: system + ${turn.messages.length} (total chars≈${JSON.stringify(payload.messages).length})`);
  const body = await postChat(baseUrl, apiKey, payload);
  const usage = pickUsage(body);
  results.push({ runId: turn.runId, usage });
  console.log(`usage: ${JSON.stringify(usage)}`);
  console.log(`finish: ${body.choices?.[0]?.finish_reason ?? '-'}\n`);
}

console.log('=== Cache interpretation ===');
if (results.length >= 2) {
  const first = results[0].usage;
  const second = results[1].usage;
  const secondCached = second.cached_tokens;
  if (typeof secondCached === 'number' && secondCached > 0) {
    console.log(`Turn 2 cached_tokens=${secondCached} — vLLM prefix cache HIT on replay.`);
  } else if (secondCached === 0) {
    console.log('Turn 2 cached_tokens=0 — no prefix hit on this endpoint.');
  } else {
    console.log('cached_tokens not returned — check vLLM --enable-prefix-caching and usage.prompt_tokens_details.');
  }
  console.log(`Turn 1 cached_tokens=${first.cached_tokens ?? 'n/a'}, Turn 2 prompt_tokens=${second.prompt_tokens ?? 'n/a'}`);
} else {
  console.log('Need at least 2 turns for cache hit comparison. Use --turns 2 or more.');
}

console.log('\nIf cache misses but offline prefix is stable, try --content raw to match OpenClaw wire format.');
