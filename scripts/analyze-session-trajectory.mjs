/**
 * Offline forensic analysis of OpenClaw session *.trajectory.jsonl files.
 *
 * Does NOT call vLLM or any HTTP endpoint — only inspects logged context.compiled
 * payloads to verify systemPrompt stability and append-only message history.
 *
 * For automated prefix diff summary:
 *   pnpm run diagnose:prompt-cache -- <trajectory.jsonl>
 *
 * For live vLLM prefix-cache verification:
 *   node scripts/replay-trajectory-to-vllm.mjs <trajectory.jsonl> --provider <id>
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/analyze-session-trajectory.mjs <trajectory.jsonl>');
  process.exit(1);
}

function hash(text) {
  return createHash('sha256').update(text || '').digest('hex').slice(0, 16);
}

function normalizeContent(content) {
  if (typeof content === 'string') return content;
  return JSON.stringify(content ?? '');
}

function fingerprintMessages(messages) {
  if (!Array.isArray(messages)) return '';
  return messages
    .map((m) => `${m?.role ?? '?'}:${normalizeContent(m?.content)}`)
    .join('\n---\n');
}

const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
const compiledTurns = [];
let turn = 0;

console.log('NOTE: offline analysis only — no HTTP requests are sent.');
console.log(`File: ${file}\n`);

for (const line of lines) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    continue;
  }

  if (parsed.type === 'context.compiled') {
    turn += 1;
    const data = parsed.data || {};
    const sys = typeof data.systemPrompt === 'string'
      ? data.systemPrompt
      : JSON.stringify(data.systemPrompt ?? '');
    const msgs = Array.isArray(data.messages) ? data.messages : [];
    const msgHashes = msgs.map((m) => hash(normalizeContent(m?.content)));

    compiledTurns.push({
      turn,
      runId: parsed.runId,
      provider: parsed.provider,
      modelId: parsed.modelId,
      sysHash: hash(sys),
      sysLen: sys.length,
      msgs,
      msgHashes,
      fingerprint: fingerprintMessages(msgs),
    });

    console.log(`\n=== Turn ${turn} context.compiled (${parsed.runId}) ===`);
    console.log(`provider=${parsed.provider ?? '-'} model=${parsed.modelId ?? '-'}`);
    console.log(`systemPrompt: len=${sys.length} hash=${hash(sys)}`);
    console.log(`messages: count=${msgs.length}`);
    if (turn === 1 && msgs.length === 0) {
      console.log('  (turn 1 often has messages=[] — user turn may be injected after compile)');
    }
    msgs.forEach((m, i) => {
      const role = m?.role ?? '?';
      const content = normalizeContent(m?.content);
      console.log(
        `  [${i}] ${role}: len=${content.length} hash=${hash(content)} head=${JSON.stringify(content.slice(0, 80))}`,
      );
    });
  }

  if (parsed.type === 'model.completed') {
    const usage = parsed.data?.usage ?? parsed.data?.promptCache?.lastCallUsage;
    console.log(`model.completed (${parsed.runId}): usage=${JSON.stringify(usage)}`);
    if (usage && Object.values(usage).every((v) => v === 0)) {
      console.log('  ^ all-zero usage in trajectory ≠ vLLM had no cache; OpenClaw custom stream often omits usage');
    }
  }
}

if (compiledTurns.length === 0) {
  console.error('\nNo context.compiled events found.');
  process.exit(1);
}

console.log('\n=== Prefix stability summary ===');
const sysHashes = new Set(compiledTurns.map((t) => t.sysHash));
console.log(`systemPrompt stable across turns: ${sysHashes.size === 1 ? 'YES' : `NO (${sysHashes.size} distinct hashes)`}`);

for (let i = 1; i < compiledTurns.length; i += 1) {
  const prev = compiledTurns[i - 1];
  const curr = compiledTurns[i];
  const sysOk = prev.sysHash === curr.sysHash;
  let msgsOk = curr.fingerprint.startsWith(prev.fingerprint);
  let reason = '';
  if (!msgsOk && prev.fingerprint.length === 0) {
    msgsOk = true;
    reason = ' (turn 1 empty messages baseline)';
  } else if (!msgsOk) {
    reason = curr.fingerprint.length < prev.fingerprint.length
      ? ' — history shrank'
      : ' — middle prefix changed';
  }
  console.log(
    `Turn ${prev.turn} → ${curr.turn}: system=${sysOk ? 'ok' : 'CHANGED'}, messages=${msgsOk ? 'append-only' : 'BREAK'}${reason}`,
  );

  const shared = Math.min(prev.msgHashes.length, curr.msgHashes.length);
  for (let j = 0; j < shared; j += 1) {
    if (prev.msgHashes[j] !== curr.msgHashes[j]) {
      console.log(`  message[${j}] hash changed: ${prev.msgHashes[j]} → ${curr.msgHashes[j]}`);
    }
  }
}

const allSysStable = sysHashes.size === 1;
const allMsgsAppend = compiledTurns.slice(1).every((curr, idx) => {
  const prev = compiledTurns[idx];
  if (prev.fingerprint.length === 0) return true;
  return curr.fingerprint.startsWith(prev.fingerprint);
});

console.log('\n=== Verdict ===');
if (allSysStable && allMsgsAppend) {
  console.log('OpenClaw compile layer: prefix looks STABLE (good for KV cache).');
  console.log('If vLLM still misses cache, test with:');
  console.log(`  node scripts/replay-trajectory-to-vllm.mjs "${file}" --provider ${compiledTurns.at(-1)?.provider ?? '<provider-id>'}`);
} else {
  console.log('OpenClaw compile layer: prefix DRIFT detected — likely root cause of cache misses.');
}
console.log('Also run: pnpm run diagnose:prompt-cache -- "' + file + '"');
