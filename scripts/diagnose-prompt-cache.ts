/**
 * CLI runner for prompt-cache diagnostics (executed via vitest or ts-node).
 *
 *   pnpm run diagnose:prompt-cache -- <session.jsonl>
 *   pnpm run diagnose:prompt-cache -- --dir ~/.openclaw/agents/main/sessions
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  buildPromptCacheDiagnosticReport,
  formatPromptCacheDiagnosticReport,
} from '../electron/utils/prompt-cache-diagnostic';

function expandHome(inputPath: string): string {
  if (inputPath.startsWith('~/')) {
    return join(homedir(), inputPath.slice(2));
  }
  return inputPath;
}

function collectJsonlFiles(targetPath: string): string[] {
  const resolved = resolve(expandHome(targetPath));
  const stat = statSync(resolved);
  if (stat.isFile()) {
    return [resolved];
  }

  const files: string[] = [];
  for (const entry of readdirSync(resolved)) {
    if (!entry.endsWith('.jsonl')) continue;
    files.push(join(resolved, entry));
  }
  return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: pnpm run diagnose:prompt-cache -- <session.jsonl|--dir sessions-dir>');
    process.exit(1);
  }

  let files: string[] = [];
  if (args[0] === '--dir') {
    const dir = args[1] ?? join(homedir(), '.openclaw', 'agents', 'main', 'sessions');
    files = collectJsonlFiles(dir).slice(0, args.includes('--all') ? undefined : 5);
  } else {
    files = collectJsonlFiles(args[0]!);
  }

  if (files.length === 0) {
    console.error('No .jsonl session files found.');
    process.exit(1);
  }

  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    const report = buildPromptCacheDiagnosticReport(file, content);
    console.log(formatPromptCacheDiagnosticReport(report));
    console.log('\n---\n');
  }
}

main();
