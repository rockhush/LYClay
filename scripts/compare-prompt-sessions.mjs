/**
 * Compare context.compiled across turns and across sessions (auto vs direct).
 *
 * Usage:
 *   node scripts/compare-prompt-sessions.mjs
 *   node scripts/compare-prompt-sessions.mjs <session-id> [session-id...]
 *   node scripts/compare-prompt-sessions.mjs --max-turns 3
 *
 * Edit COMPARE_CONFIG below to pin auto / direct session IDs (no CLI args needed).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Hardcoded compare sets — fill in session UUIDs when you have them.
// ---------------------------------------------------------------------------
const COMPARE_CONFIG = {
  /** ly-auto sessions to compare with each other */
  auto: [
    'addb4ae6-7336-460f-91e8-2ffc31cf8429',
    '86e9e201-fa3b-45cf-a9f4-469cfc279812',
  ],
  /** direct provider sessions: label -> session id(s) */
  direct: {
    'minimax': [
      '4aa7a588-affc-4019-b5f5-bb2ae5057706',
      'fbe4140f-de19-4412-bd4b-b9cb1b196790',
    ],
    'qwen-122b': [
      '6ba7b9af-3c14-4f06-8970-6d1d30df6453',
      '0b503d8a-e30c-4e9d-a953-70eb9082bb39',
    ],
    'qwen-397b': [
      '8986e12f-8cb1-4e2e-9bb9-cd68775c987f',
      '6234d0ec-e50f-4a94-ae9d-0cf18073ca64',
    ],
  },
};

const SESSIONS_DIR = join(homedir(), '.openclaw', 'agents', 'main', 'sessions');

function parseArgs(argv) {
  const opts = { maxTurns: 3 };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--max-turns') {
      opts.maxTurns = Number(argv[++i]);
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    }
  }
  return { positional, opts };
}

function hash(text) {
  return createHash('sha256').update(text || '').digest('hex').slice(0, 16);
}

function normalizeContent(content) {
  if (typeof content === 'string') return content;
  return JSON.stringify(content ?? '');
}

function normalizeSystemPrompt(systemPrompt) {
  if (typeof systemPrompt === 'string') return systemPrompt;
  if (systemPrompt && typeof systemPrompt === 'object') {
    return JSON.stringify(systemPrompt);
  }
  return '';
}

function fingerprintMessages(messages) {
  if (!Array.isArray(messages)) return '';
  return messages
    .map((m) => `${m?.role ?? '?'}:${normalizeContent(m?.content)}`)
    .join('\n---\n');
}

function fingerprintTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return '';
  return JSON.stringify(tools);
}

function resolveTrajectoryPath(sessionIdOrPath) {
  if (sessionIdOrPath.endsWith('.jsonl')) {
    return existsSync(sessionIdOrPath) ? sessionIdOrPath : null;
  }
  const withTrajectory = join(SESSIONS_DIR, `${sessionIdOrPath}.trajectory.jsonl`);
  if (existsSync(withTrajectory)) return withTrajectory;
  const plain = join(SESSIONS_DIR, `${sessionIdOrPath}.jsonl`);
  if (existsSync(plain)) return plain.replace(/\.jsonl$/, '.trajectory.jsonl');
  return null;
}

function loadCompiledTurns(sessionId, label, maxTurns) {
  const path = resolveTrajectoryPath(sessionId);
  if (!path) {
    return { sessionId, label, error: `trajectory not found for ${sessionId}` };
  }

  const turns = [];
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed.type !== 'context.compiled') continue;

    const data = parsed.data ?? {};
    const systemPrompt = normalizeSystemPrompt(data.systemPrompt);
    const messages = Array.isArray(data.messages) ? data.messages : [];
    const tools = Array.isArray(data.tools) ? data.tools : [];
    const msgFingerprint = fingerprintMessages(messages);
    const toolsFingerprint = fingerprintTools(tools);
    const payloadFingerprint = JSON.stringify({
      systemPrompt,
      messages: msgFingerprint,
      tools: toolsFingerprint,
    });

    turns.push({
      turn: turns.length + 1,
      runId: parsed.runId,
      provider: parsed.provider,
      modelId: parsed.modelId,
      path,
      systemHash: hash(systemPrompt),
      systemLen: systemPrompt.length,
      messagesCount: messages.length,
      toolsCount: tools.length,
      toolsHash: hash(toolsFingerprint),
      messagesFingerprint: msgFingerprint,
      payloadHash: hash(payloadFingerprint),
      usage: null,
    });

    if (turns.length >= maxTurns) break;
  }

  // Attach usage from model.completed (same run order as compiled turns)
  const usageByRunId = new Map();
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed.type !== 'model.completed') continue;
    const usage = parsed.data?.usage ?? parsed.data?.promptCache?.lastCallUsage;
    if (parsed.runId) usageByRunId.set(parsed.runId, usage);
  }
  for (const turn of turns) {
    turn.usage = usageByRunId.get(turn.runId) ?? null;
  }

  return { sessionId, label, path, turns };
}

function compareWithinSession(report) {
  console.log(`\n--- ${report.label} (${report.sessionId}) ---`);
  if (report.error) {
    console.log(`  ERROR: ${report.error}`);
    return { stable: false };
  }
  if (report.turns.length === 0) {
    console.log('  ERROR: no context.compiled events');
    return { stable: false };
  }

  for (const turn of report.turns) {
    const u = turn.usage;
    const cacheRead = u?.cacheRead ?? u?.cache_read ?? '-';
    const total = u?.total ?? u?.totalTokens ?? '-';
    console.log(
      `  Turn ${turn.turn}: provider=${turn.provider ?? '-'} model=${turn.modelId ?? '-'}`
      + ` sys=${turn.systemHash} tools=${turn.toolsCount}@${turn.toolsHash}`
      + ` msgs=${turn.messagesCount} payload=${turn.payloadHash}`
      + ` usage(cacheRead=${cacheRead}, total=${total})`,
    );
  }

  let stable = true;
  for (let i = 1; i < report.turns.length; i += 1) {
    const prev = report.turns[i - 1];
    const curr = report.turns[i];
    const sysOk = prev.systemHash === curr.systemHash;
    const toolsOk = prev.toolsHash === curr.toolsHash;
    let msgsOk = curr.messagesFingerprint.startsWith(prev.messagesFingerprint);
    let note = '';
    if (!msgsOk && prev.messagesFingerprint.length === 0) {
      msgsOk = true;
      note = ' (turn1 empty messages baseline)';
    } else if (!msgsOk) {
      note = curr.messagesFingerprint.length < prev.messagesFingerprint.length
        ? ' — history shrank'
        : ' — middle prefix changed';
    }
    const ok = sysOk && toolsOk && msgsOk;
    if (!ok) stable = false;
    console.log(
      `  Turn ${prev.turn}→${curr.turn}: system=${sysOk ? 'ok' : 'CHANGED'}`
      + ` tools=${toolsOk ? 'ok' : 'CHANGED'}`
      + ` messages=${msgsOk ? 'append-only' : 'BREAK'}${note}`,
    );
  }

  const sysHashes = new Set(report.turns.map((t) => t.systemHash));
  console.log(`  Verdict: ${stable ? 'PREFIX STABLE' : 'PREFIX DRIFT'}`);
  if (sysHashes.size > 1) console.log('  ^ systemPrompt hash changed between turns');
  return { stable, turns: report.turns };
}

function compareTurnAcrossSessions(turnIndex, reports, title) {
  console.log(`\n=== ${title} — Turn ${turnIndex} cross-session ===`);
  const rows = reports
    .filter((r) => !r.error && r.turns[turnIndex - 1])
    .map((r) => ({
      label: r.label,
      sessionId: r.sessionId,
      turn: r.turns[turnIndex - 1],
    }));

  if (rows.length === 0) {
    console.log('  (no sessions with this turn)');
    return;
  }

  for (const row of rows) {
    const t = row.turn;
    const u = t.usage;
    console.log(
      `  [${row.label}] payload=${t.payloadHash} sys=${t.systemHash} tools=${t.toolsHash}`
      + ` msgs=${t.messagesCount} cacheRead=${u?.cacheRead ?? '-'}`,
    );
  }

  const baseline = rows[0];
  for (let i = 1; i < rows.length; i += 1) {
    const curr = rows[i];
    const samePayload = baseline.turn.payloadHash === curr.turn.payloadHash;
    const sameSys = baseline.turn.systemHash === curr.turn.systemHash;
    const sameTools = baseline.turn.toolsHash === curr.turn.toolsHash;
    const sameMsgs = baseline.turn.messagesFingerprint === curr.turn.messagesFingerprint;
    console.log(
      `  ${baseline.label} vs ${curr.label}:`
      + ` payload=${samePayload ? 'SAME' : 'DIFF'}`
      + ` system=${sameSys ? 'SAME' : 'DIFF'}`
      + ` tools=${sameTools ? 'SAME' : 'DIFF'}`
      + ` messages=${sameMsgs ? 'SAME' : 'DIFF'}`,
    );
    if (!samePayload) {
      if (!sameSys) console.log('    → systemPrompt differs');
      if (!sameTools) console.log('    → tools schema differs');
      if (!sameMsgs) console.log('    → messages differ');
    }
  }
}

function buildReportList(cliIds, opts) {
  const reports = [];
  const seen = new Set();

  function add(sessionId, label) {
    const key = sessionId.trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    reports.push(loadCompiledTurns(key, label, opts.maxTurns));
  }

  for (const id of COMPARE_CONFIG.auto) add(id, `auto:${id.slice(0, 8)}`);
  for (const [modelLabel, ids] of Object.entries(COMPARE_CONFIG.direct)) {
    for (const id of ids) add(id, `direct:${modelLabel}`);
  }
  for (const id of cliIds) add(id, `cli:${id.slice(0, 8)}`);

  return reports;
}

function main() {
  const { positional, opts } = parseArgs(process.argv.slice(2));
  const reports = buildReportList(positional, opts);

  if (reports.length === 0) {
    console.error('No sessions to compare.');
    console.error('');
    console.error('Either:');
    console.error('  1. Edit COMPARE_CONFIG in scripts/compare-prompt-sessions.mjs');
    console.error('  2. Pass session ids: node scripts/compare-prompt-sessions.mjs <uuid> [uuid...]');
    process.exit(1);
  }

  console.log('Compare context.compiled (offline, no HTTP)');
  console.log(`Sessions dir: ${SESSIONS_DIR}`);
  console.log(`Max turns per session: ${opts.maxTurns}`);
  console.log(`Session count: ${reports.length}`);

  const withinResults = [];
  for (const report of reports) {
    withinResults.push(compareWithinSession(report));
  }

  for (let turn = 1; turn <= opts.maxTurns; turn += 1) {
    const autoReports = reports.filter((r) => r.label.startsWith('auto:'));
    const directReports = reports.filter((r) => r.label.startsWith('direct:'));
    const cliReports = reports.filter((r) => r.label.startsWith('cli:'));

    if (autoReports.length >= 2) {
      compareTurnAcrossSessions(turn, autoReports, 'Auto sessions');
    }
    if (directReports.length >= 2) {
      compareTurnAcrossSessions(turn, directReports, 'Direct sessions');
    }
    if (autoReports.length > 0 && directReports.length > 0) {
      compareTurnAcrossSessions(turn, [...autoReports, ...directReports], 'Auto vs Direct');
    }
    if (cliReports.length >= 2) {
      compareTurnAcrossSessions(turn, cliReports, 'CLI sessions');
    }
    if (reports.length >= 2 && autoReports.length === 0 && directReports.length === 0 && cliReports.length === 0) {
      compareTurnAcrossSessions(turn, reports, 'All sessions');
    }
  }

  console.log('\n=== Summary ===');
  const drift = withinResults.filter((r) => r.stable === false);
  if (drift.length === 0) {
    console.log('All sessions: within-session prefix looks STABLE.');
    console.log('If KV cache still drops on auto, suspect nginx routing / vLLM instance stickiness.');
  } else {
    console.log(`${drift.length} session(s) have within-session PREFIX DRIFT — fix OpenClaw compile first.`);
  }
}

main();
