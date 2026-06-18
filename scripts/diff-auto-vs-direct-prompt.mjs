/**
 * Diff ly-auto vs custom direct sessions: systemPrompt + tools per turn.
 *
 * Usage:
 *   node scripts/diff-auto-vs-direct-prompt.mjs
 *   node scripts/diff-auto-vs-direct-prompt.mjs --turn 1
 *   node scripts/diff-auto-vs-direct-prompt.mjs --pair addb4ae6-... 6ba7b9af-...
 *   node scripts/diff-auto-vs-direct-prompt.mjs --out-dir ./prompt-diff-out
 *
 * Edit PAIRS below (auto session id + direct session id + label).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SESSIONS_DIR = join(homedir(), '.openclaw', 'agents', 'main', 'sessions');
const MODELS_JSON = join(homedir(), '.openclaw', 'agents', 'main', 'agent', 'models.json');

/** auto session -> direct session (same test scenario, different provider path) */
const PAIRS = [
  {
    label: 'qwen-122b',
    auto: 'addb4ae6-7336-460f-91e8-2ffc31cf8429',
    direct: '6ba7b9af-3c14-4f06-8970-6d1d30df6453',
    directProvider: 'custom-customef',
    directModel: 'qwen35-122b',
  },
  {
    label: 'minimax',
    auto: '86e9e201-fa3b-45cf-a9f4-469cfc279812',
    direct: '4aa7a588-affc-4019-b5f5-bb2ae5057706',
    directProvider: 'custom-customa6',
    directModel: 'MiniMax-M2.7',
  },
];

function parseArgs(argv) {
  const opts = { turn: 1, outDir: null, pairs: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--turn') opts.turn = Number(argv[++i]);
    else if (arg === '--out-dir') opts.outDir = argv[++i];
    else if (arg === '--pair') {
      opts.pairs.push({ label: 'cli', auto: argv[++i], direct: argv[++i] });
    } else if (!arg.startsWith('-')) {
      // ignore
    }
  }
  return opts;
}

function hash(text) {
  return createHash('sha256').update(text || '').digest('hex').slice(0, 16);
}

function stableJson(value) {
  return JSON.stringify(value ?? null);
}

function normalizeSystemPrompt(systemPrompt) {
  if (typeof systemPrompt === 'string') return systemPrompt;
  if (systemPrompt && typeof systemPrompt === 'object') {
    if (systemPrompt.truncated) {
      return null;
    }
    return JSON.stringify(systemPrompt);
  }
  return '';
}

function resolveTrajectoryPath(sessionId) {
  const withTrajectory = join(SESSIONS_DIR, `${sessionId}.trajectory.jsonl`);
  if (existsSync(withTrajectory)) return withTrajectory;
  return null;
}

function loadTrajectory(sessionId) {
  const path = resolveTrajectoryPath(sessionId);
  if (!path) return { sessionId, error: `missing ${sessionId}.trajectory.jsonl` };
  const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean);
  const events = [];
  let metadataReport = null;
  let metadataPlugins = null;
  let metadataModel = null;

  for (const line of lines) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    events.push(parsed);
    if (parsed.type === 'trace.metadata' && parsed.data?.prompting?.systemPromptReport) {
      metadataReport = parsed.data.prompting.systemPromptReport;
      metadataPlugins = parsed.data.plugins?.entries ?? null;
      metadataModel = parsed.data.model ?? null;
    }
  }
  return { sessionId, path, events, metadataReport, metadataPlugins, metadataModel };
}

function getCompiledTurn(trajectory, turnIndex) {
  let n = 0;
  for (const event of trajectory.events ?? []) {
    if (event.type !== 'context.compiled') continue;
    n += 1;
    if (n === turnIndex) {
      const data = event.data ?? {};
      const systemText = normalizeSystemPrompt(data.systemPrompt);
      const tools = Array.isArray(data.tools) ? data.tools : [];
      return {
        turn: turnIndex,
        runId: event.runId,
        provider: event.provider,
        modelId: event.modelId,
        systemText,
        systemTruncated: Boolean(data.systemPrompt?.truncated),
        systemOriginalChars: data.systemPrompt?.originalChars ?? systemText?.length ?? 0,
        tools,
        messagesCount: Array.isArray(data.messages) ? data.messages.length : 0,
      };
    }
  }
  return null;
}

function fingerprintTool(tool) {
  return {
    name: tool?.name ?? '?',
    description: tool?.description ?? '',
    parametersJson: stableJson(tool?.parameters),
    hash: hash(`${tool?.name ?? ''}\n${tool?.description ?? ''}\n${stableJson(tool?.parameters)}`),
  };
}

function diffTools(autoTools, directTools) {
  const autoMap = new Map(autoTools.map((t) => [t.name, fingerprintTool(t)]));
  const directMap = new Map(directTools.map((t) => [t.name, fingerprintTool(t)]));
  const allNames = [...new Set([...autoMap.keys(), ...directMap.keys()])].sort();

  const onlyAuto = [];
  const onlyDirect = [];
  const changed = [];
  const same = [];

  for (const name of allNames) {
    const a = autoMap.get(name);
    const d = directMap.get(name);
    if (a && !d) {
      onlyAuto.push(name);
      continue;
    }
    if (!a && d) {
      onlyDirect.push(name);
      continue;
    }
    if (a.hash === d.hash) same.push(name);
    else {
      changed.push({
        name,
        autoHash: a.hash,
        directHash: d.hash,
        descriptionDiff: a.description !== d.description,
        parametersDiff: a.parametersJson !== d.parametersJson,
        autoDescriptionLen: a.description.length,
        directDescriptionLen: d.description.length,
      });
    }
  }

  return { onlyAuto, onlyDirect, changed, same, autoCount: autoTools.length, directCount: directTools.length };
}

function diffSystemPromptReports(autoReport, directReport) {
  if (!autoReport || !directReport) return null;
  const fields = [
    ['systemPrompt.chars', autoReport.systemPrompt?.chars, directReport.systemPrompt?.chars],
    ['systemPrompt.projectContextChars', autoReport.systemPrompt?.projectContextChars, directReport.systemPrompt?.projectContextChars],
    ['systemPrompt.nonProjectContextChars', autoReport.systemPrompt?.nonProjectContextChars, directReport.systemPrompt?.nonProjectContextChars],
    ['skills.promptChars', autoReport.skills?.promptChars, directReport.skills?.promptChars],
    ['tools.schemaChars', autoReport.tools?.schemaChars, directReport.tools?.schemaChars],
  ];

  const numericDiffs = fields.filter(([, a, b]) => a !== b).map(([field, a, b]) => ({ field, auto: a, direct: b, delta: (b ?? 0) - (a ?? 0) }));

  const autoToolEntries = new Map((autoReport.tools?.entries ?? []).map((e) => [e.name, e]));
  const directToolEntries = new Map((directReport.tools?.entries ?? []).map((e) => [e.name, e]));
  const toolReportDiffs = [];
  for (const [name, a] of autoToolEntries) {
    const d = directToolEntries.get(name);
    if (!d) continue;
    if (a.summaryChars !== d.summaryChars || a.schemaChars !== d.schemaChars) {
      toolReportDiffs.push({
        name,
        autoSummaryChars: a.summaryChars,
        directSummaryChars: d.summaryChars,
        autoSchemaChars: a.schemaChars,
        directSchemaChars: d.schemaChars,
      });
    }
  }

  return { numericDiffs, toolReportDiffs };
}

function loadModelsJson() {
  if (!existsSync(MODELS_JSON)) return null;
  try {
    return JSON.parse(readFileSync(MODELS_JSON, 'utf8'));
  } catch {
    return null;
  }
}

function summarizeModelConfig(modelsJson, provider, modelId) {
  const entry = modelsJson?.providers?.[provider]?.models?.find((m) => m.id === modelId);
  if (!entry) return null;
  return {
    reasoning: entry.reasoning ?? false,
    input: entry.input ?? [],
    maxTokens: entry.maxTokens,
    contextWindow: entry.contextWindow,
    compat: entry.compat ?? {},
  };
}

function printPluginDiff(autoPlugins, directPlugins) {
  if (!Array.isArray(autoPlugins) || !Array.isArray(directPlugins)) return;
  const autoEnabled = new Set(autoPlugins.filter((p) => p.enabled && p.activated).map((p) => p.id));
  const directEnabled = new Set(directPlugins.filter((p) => p.enabled && p.activated).map((p) => p.id));
  const onlyAuto = [...autoEnabled].filter((id) => !directEnabled.has(id));
  const onlyDirect = [...directEnabled].filter((id) => !autoEnabled.has(id));
  if (onlyAuto.length === 0 && onlyDirect.length === 0) return;
  console.log('  Active plugins differ:');
  if (onlyAuto.length) console.log(`    auto only:   ${onlyAuto.join(', ')}`);
  if (onlyDirect.length) console.log(`    direct only: ${onlyDirect.join(', ')}`);
}

function writeOutFiles(outDir, pairLabel, turn, auto, direct) {
  mkdirSync(outDir, { recursive: true });
  const prefix = join(outDir, `${pairLabel}-turn${turn}`);
  if (auto.systemText) writeFileSync(`${prefix}-auto-system.txt`, auto.systemText, 'utf8');
  if (direct.systemText) writeFileSync(`${prefix}-direct-system.txt`, direct.systemText, 'utf8');
  writeFileSync(`${prefix}-auto-tools.json`, JSON.stringify(auto.tools, null, 2), 'utf8');
  writeFileSync(`${prefix}-direct-tools.json`, JSON.stringify(direct.tools, null, 2), 'utf8');
  console.log(`  Wrote ${prefix}-*.txt/json`);
}

function comparePair(pair, opts) {
  console.log(`\n${'='.repeat(72)}`);
  console.log(`PAIR: ${pair.label}`);
  console.log(`  auto:   ${pair.auto}`);
  console.log(`  direct: ${pair.direct}`);

  const autoTraj = loadTrajectory(pair.auto);
  const directTraj = loadTrajectory(pair.direct);
  if (autoTraj.error || directTraj.error) {
    console.log(`  ERROR: ${autoTraj.error || directTraj.error}`);
    return;
  }

  const autoTurn = getCompiledTurn(autoTraj, opts.turn);
  const directTurn = getCompiledTurn(directTraj, opts.turn);
  if (!autoTurn || !directTurn) {
    console.log(`  ERROR: missing context.compiled turn ${opts.turn}`);
    return;
  }

  console.log(`\n--- Turn ${opts.turn} ---`);
  console.log(`  auto:   ${autoTurn.provider}/${autoTurn.modelId} msgs=${autoTurn.messagesCount}`);
  console.log(`  direct: ${directTurn.provider}/${directTurn.modelId} msgs=${directTurn.messagesCount}`);

  const autoSys = autoTurn.systemText ?? '';
  const directSys = directTurn.systemText ?? '';
  const sysHashAuto = hash(autoSys || String(autoTurn.systemOriginalChars));
  const sysHashDirect = hash(directSys || String(directTurn.systemOriginalChars));

  console.log('\n[systemPrompt]');
  if (autoTurn.systemTruncated || directTurn.systemTruncated) {
    console.log(`  WARNING: trajectory truncates systemPrompt at 32k chars`);
    console.log(`  auto originalChars=${autoTurn.systemOriginalChars}  direct originalChars=${directTurn.systemOriginalChars}`);
  }
  console.log(`  hash: auto=${sysHashAuto} direct=${sysHashDirect} ${sysHashAuto === sysHashDirect ? 'SAME' : 'DIFF'}`);
  if (autoSys && directSys) {
    console.log(`  len:  auto=${autoSys.length} direct=${directSys.length} delta=${directSys.length - autoSys.length}`);
    if (autoSys !== directSys) {
      const minLen = Math.min(autoSys.length, directSys.length);
      let firstDiff = -1;
      for (let i = 0; i < minLen; i += 1) {
        if (autoSys[i] !== directSys[i]) {
          firstDiff = i;
          break;
        }
      }
      if (firstDiff >= 0) {
        const ctx = (text, pos) => JSON.stringify(text.slice(Math.max(0, pos - 40), pos + 40));
        console.log(`  first diff at char ${firstDiff}`);
        console.log(`    auto:   ${ctx(autoSys, firstDiff)}`);
        console.log(`    direct: ${ctx(directSys, firstDiff)}`);
      } else if (autoSys.length !== directSys.length) {
        console.log(`  prefixes match for ${minLen} chars; lengths differ (suffix-only difference)`);
      }
    }
  }

  const reportDiff = diffSystemPromptReports(autoTraj.metadataReport, directTraj.metadataReport);
  if (reportDiff) {
    console.log('\n[systemPromptReport from trace.metadata]');
    if (reportDiff.numericDiffs.length === 0) {
      console.log('  numeric breakdown: SAME');
    } else {
      for (const d of reportDiff.numericDiffs) {
        console.log(`  ${d.field}: auto=${d.auto} direct=${d.direct} (delta ${d.delta >= 0 ? '+' : ''}${d.delta})`);
      }
    }
    if (reportDiff.toolReportDiffs.length > 0) {
      console.log('  per-tool schema/summary size diffs:');
      for (const t of reportDiff.toolReportDiffs) {
        console.log(
          `    ${t.name}: summary ${t.autoSummaryChars}→${t.directSummaryChars}, schema ${t.autoSchemaChars}→${t.directSchemaChars}`,
        );
      }
    }
  }

  const modelsJson = loadModelsJson();
  if (modelsJson && pair.directProvider && pair.directModel) {
    const autoCfg = summarizeModelConfig(modelsJson, 'ly-auto', 'auto');
    const directCfg = summarizeModelConfig(modelsJson, pair.directProvider, pair.directModel);
    console.log('\n[models.json capability flags]');
    console.log(`  ly-auto/auto:`, JSON.stringify(autoCfg));
    console.log(`  ${pair.directProvider}/${pair.directModel}:`, JSON.stringify(directCfg));
    if (autoCfg && directCfg && autoCfg.reasoning !== directCfg.reasoning) {
      console.log('  ^ reasoning flag differs — OpenClaw compiles different tool text + transport behavior');
    }
  }

  printPluginDiff(autoTraj.metadataPlugins, directTraj.metadataPlugins);

  const toolsDiff = diffTools(autoTurn.tools, directTurn.tools);
  console.log('\n[tools]');
  console.log(`  count: auto=${toolsDiff.autoCount} direct=${toolsDiff.directCount}`);
  console.log(`  same hash: ${toolsDiff.same.length}  changed: ${toolsDiff.changed.length}`);
  console.log(`  only auto: ${toolsDiff.onlyAuto.length ? toolsDiff.onlyAuto.join(', ') : '-'}`);
  console.log(`  only direct: ${toolsDiff.onlyDirect.length ? toolsDiff.onlyDirect.join(', ') : '-'}`);
  if (toolsDiff.changed.length > 0) {
    console.log('  changed tools:');
    for (const c of toolsDiff.changed) {
      const parts = [];
      if (c.descriptionDiff) parts.push(`description len ${c.autoDescriptionLen}→${c.directDescriptionLen}`);
      if (c.parametersDiff) parts.push('parameters JSON differs');
      console.log(`    ${c.name}: ${parts.join('; ') || 'hash differs'}`);
    }
  }

  if (opts.outDir) {
    writeOutFiles(opts.outDir, pair.label, opts.turn, autoTurn, directTurn);
  }

  console.log('\n[verdict]');
  const sysSame = autoSys && directSys && autoSys === directSys;
  const toolsSame = toolsDiff.changed.length === 0 && toolsDiff.onlyAuto.length === 0 && toolsDiff.onlyDirect.length === 0;
  if (sysSame && toolsSame) {
    console.log('  systemPrompt + tools MATCH — auto/direct compile path aligned for this turn.');
  } else {
    console.log('  systemPrompt + tools DIFFER — KV cache prefix will not match direct even on same vLLM backend.');
    if (!sysSame) console.log('  → Fix: align models.json (reasoning/input/compat) and plugin activation between ly-auto and custom.');
    if (!toolsSame) console.log('  → Tools differ usually from model capability flags (e.g. reasoning/image wording) or active plugins.');
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const pairs = opts.pairs.length > 0 ? opts.pairs : PAIRS;

  console.log('Diff ly-auto vs custom direct (context.compiled)');
  console.log(`Sessions dir: ${SESSIONS_DIR}`);
  console.log(`Turn: ${opts.turn}`);

  for (const pair of pairs) {
    comparePair(pair, opts);
  }

  console.log('\nNote: if systemPrompt is truncated in trajectory, use --out-dir only when full text is present,');
  console.log('or export full compiled payloads from OpenClaw before trajectory size limits apply.');
}

main();
