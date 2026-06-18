/**
 * Print assistant message.usage from session .jsonl and model.completed from .trajectory.jsonl
 *
 * Usage: node scripts/inspect-session-usage.mjs <session-id-or-path>
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: node scripts/inspect-session-usage.mjs <session-id-or-.jsonl-path>');
  process.exit(1);
}

function resolveSessionPath(input) {
  if (input.endsWith('.jsonl')) return input;
  const base = join(homedir(), '.openclaw', 'agents', 'main', 'sessions');
  const withExt = join(base, `${input}.jsonl`);
  if (existsSync(withExt)) return withExt;
  return join(base, input);
}

const sessionPath = resolveSessionPath(arg);
if (!existsSync(sessionPath)) {
  console.error(`Not found: ${sessionPath}`);
  process.exit(1);
}

const trajectoryPath = sessionPath.replace(/\.jsonl$/, '.trajectory.jsonl');
const sessionId = sessionPath.split(/[/\\]/).pop()?.replace(/\.jsonl$/, '') ?? arg;

console.log(`Session: ${sessionId}`);
console.log(`Transcript: ${sessionPath}`);
console.log(`Trajectory: ${existsSync(trajectoryPath) ? trajectoryPath : '(missing)'}\n`);

let turn = 0;
for (const line of readFileSync(sessionPath, 'utf8').split(/\r?\n/)) {
  if (!line.trim()) continue;
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    continue;
  }
  const msg = parsed.message;
  if (msg?.role !== 'assistant') continue;
  turn += 1;
  const usage = msg.usage;
  console.log(`--- Transcript assistant #${turn} ---`);
  console.log(`provider=${msg.provider ?? '-'} model=${msg.model ?? '-'}`);
  console.log(`usage=${usage ? JSON.stringify(usage) : '(missing)'}`);
}

if (existsSync(trajectoryPath)) {
  console.log('\n=== Trajectory model.completed ===');
  for (const line of readFileSync(trajectoryPath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed.type !== 'model.completed') continue;
    const usage = parsed.data?.usage ?? parsed.data?.promptCache?.lastCallUsage;
    console.log(`runId=${parsed.runId} usage=${JSON.stringify(usage)}`);
  }
}
