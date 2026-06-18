/**
 * Send 4 sequential chat/completions requests (from trajectory snapshots or a
 * built-in multi-turn script) to one or more vLLM backends and print usage/cache fields.
 *
 * Usage:
 *   node scripts/probe-vllm-four-turns.mjs [trajectory.jsonl]
 *   node scripts/probe-vllm-four-turns.mjs --backend minimax
 *   node scripts/probe-vllm-four-turns.mjs trajectory.jsonl --backend all --content text
 *
 * Backends (built-in):
 *   minimax  -> 10.64.22.11  MiniMax-M2.7
 *   qwen397  -> 10.64.22.12  qwen3.5-397b
 *   qwen122  -> 10.7.221.62   qwen35-122b
 *   all      -> run all three
 */
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BACKENDS = {
  minimax: {
    label: 'MiniMax-M2.7 @ 10.64.22.11',
    baseUrl: 'http://10.64.22.11:8000/v1',
    apiKey: 'sk-lyitech',
    model: 'MiniMax-M2.7',
  },
  qwen397: {
    label: 'qwen3.5-397b @ 10.64.22.12',
    baseUrl: 'http://10.64.22.12:8000/v1',
    apiKey: 'sk-lyitech',
    model: 'qwen3.5-397b',
  },
  qwen122: {
    label: 'qwen35-122b @ 10.7.221.62',
    baseUrl: 'http://10.7.221.62:8000/v1',
    apiKey: 'sk-lyitech',
    model: 'qwen35-122b',
  },
};

const DEFAULT_TRAJECTORY = join(
  homedir(),
  '.openclaw',
  'agents',
  'main',
  'sessions',
  '02541a93-6548-4776-ae05-0e9d726d098f.trajectory.jsonl',
);

function parseArgs(argv) {
  const positional = [];
  const opts = {
    backend: 'all',
    content: 'text',
    maxTokens: 16,
    delayMs: 500,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--backend') opts.backend = argv[++i];
    else if (arg === '--content') opts.content = argv[++i];
    else if (arg === '--max-tokens') opts.maxTokens = Number(argv[++i]);
    else if (arg === '--delay-ms') opts.delayMs = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (!arg.startsWith('-')) positional.push(arg);
  }
  return { trajectory: positional[0], opts };
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

function loadCompiledTurns(file, limit = 4) {
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
      systemPrompt: typeof data.systemPrompt === 'string'
        ? data.systemPrompt
        : JSON.stringify(data.systemPrompt ?? ''),
      messages: Array.isArray(data.messages) ? data.messages : [],
    });
    if (turns.length >= limit) break;
  }
  return turns;
}

function builtInFourTurns() {
  const systemPrompt = 'You are a helpful assistant. Reply briefly in Chinese.';
  return [
    { runId: 'builtin-1', systemPrompt, messages: [] },
    {
      runId: 'builtin-2',
      systemPrompt,
      messages: [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '你好！有什么我可以帮你的吗？' },
      ],
    },
    {
      runId: 'builtin-3',
      systemPrompt,
      messages: [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '你好！有什么我可以帮你的吗？' },
        { role: 'user', content: '我想学计算器' },
        { role: 'assistant', content: '很好的方向！你想从哪方面开始？' },
      ],
    },
    {
      runId: 'builtin-4',
      systemPrompt,
      messages: [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '你好！有什么我可以帮你的吗？' },
        { role: 'user', content: '我想学计算器' },
        { role: 'assistant', content: '很好的方向！你想从哪方面开始？' },
        { role: 'user', content: '计算机组成原理和网络' },
        { role: 'assistant', content: '这两门课是计算机科学的基础。' },
      ],
    },
  ];
}

function buildPayload(turn, model, contentMode, maxTokens) {
  const messages = [{ role: 'system', content: turn.systemPrompt }];
  for (const message of turn.messages) {
    messages.push({
      role: message.role,
      content: flattenContent(message.content, contentMode),
    });
  }
  return { model, messages, max_tokens: maxTokens, stream: false };
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postChat(baseUrl, apiKey, payload) {
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const started = Date.now();
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });
  const elapsedMs = Date.now() - started;
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${url} (${elapsedMs}ms)\n${text.slice(0, 1000)}`);
  }
  return { body, elapsedMs };
}

function resolveBackends(key) {
  if (key === 'all') return Object.entries(BACKENDS);
  const entry = BACKENDS[key];
  if (!entry) {
    const names = [...Object.keys(BACKENDS), 'all'].join(', ');
    throw new Error(`Unknown --backend "${key}". Choose: ${names}`);
  }
  return [[key, entry]];
}

function formatUsage(usage) {
  return [
    `prompt=${usage.prompt_tokens ?? '-'}`,
    `completion=${usage.completion_tokens ?? '-'}`,
    `total=${usage.total_tokens ?? '-'}`,
    `cached_tokens=${usage.cached_tokens ?? '-'}`,
    `cache_write=${usage.cache_write ?? '-'}`,
  ].join('  ');
}

async function probeBackend(backendKey, backend, turns, opts) {
  console.log(`\n${'='.repeat(72)}`);
  console.log(`Backend: ${backend.label} (${backendKey})`);
  console.log(`URL: ${backend.baseUrl}  model=${backend.model}  content=${opts.content}`);
  console.log('='.repeat(72));

  const rows = [];
  for (let i = 0; i < turns.length; i += 1) {
    const turn = turns[i];
    const payload = buildPayload(turn, backend.model, opts.content, opts.maxTokens);
    const userCount = turn.messages.filter((m) => m.role === 'user').length;
    console.log(
      `\n[Turn ${i + 1}/4] runId=${turn.runId}  messages=${turn.messages.length}  users=${userCount}`,
    );
    try {
      const { body, elapsedMs } = await postChat(backend.baseUrl, backend.apiKey, payload);
      const usage = pickUsage(body);
      const reply = body.choices?.[0]?.message?.content ?? '';
      rows.push({ turn: i + 1, ok: true, usage, elapsedMs });
      console.log(`  ${elapsedMs}ms  ${formatUsage(usage)}`);
      console.log(`  reply: ${JSON.stringify(String(reply).slice(0, 120))}`);
    } catch (err) {
      rows.push({ turn: i + 1, ok: false, error: String(err) });
      console.log(`  ERROR: ${err.message ?? err}`);
    }
    if (i < turns.length - 1 && opts.delayMs > 0) {
      await sleep(opts.delayMs);
    }
  }

  console.log('\n--- Summary ---');
  for (const row of rows) {
    if (!row.ok) {
      console.log(`  Turn ${row.turn}: FAILED`);
      continue;
    }
    const hit = typeof row.usage.cached_tokens === 'number' && row.usage.cached_tokens > 0;
    console.log(
      `  Turn ${row.turn}: cached_tokens=${row.usage.cached_tokens ?? '-'}  ${hit ? 'HIT' : 'miss/n/a'}  (${row.elapsedMs}ms)`,
    );
  }
  return rows;
}

async function main() {
  const { trajectory, opts } = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(0, 14).join('\n'));
    process.exit(0);
  }

  const trajectoryPath = trajectory ?? (existsSync(DEFAULT_TRAJECTORY) ? DEFAULT_TRAJECTORY : null);
  let turns;
  let source;
  if (trajectoryPath && existsSync(trajectoryPath)) {
    turns = loadCompiledTurns(trajectoryPath, 4);
    source = trajectoryPath;
  } else {
    turns = builtInFourTurns();
    source = '(built-in 4-turn script)';
  }

  if (turns.length < 4) {
    console.error(`Need 4 context.compiled turns, found ${turns.length} in ${source}`);
    process.exit(1);
  }

  console.log(`Source: ${source}`);
  console.log(`Turn snapshots: ${turns.map((t) => `${t.runId}[${t.messages.length} msgs]`).join(' -> ')}`);

  const backends = resolveBackends(opts.backend);
  const allResults = {};
  for (const [key, backend] of backends) {
    allResults[key] = await probeBackend(key, backend, turns, opts);
  }

  if (backends.length > 1) {
    console.log(`\n${'='.repeat(72)}`);
    console.log('Cross-backend cached_tokens (turn 2-4):');
    for (const [key, backend] of backends) {
      const rows = allResults[key] ?? [];
      const cached = rows.filter((r) => r.ok).map((r) => r.usage.cached_tokens ?? '-');
      console.log(`  ${backend.label}: [${cached.join(', ')}]`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
