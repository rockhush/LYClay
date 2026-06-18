#!/usr/bin/env node
/**
 * Parse Nginx/OpenResty access logs for auto-gateway routing headers.
 *
 * Expected log format should include response headers such as:
 *   X-Selected-Model, X-Route-Reason, X-Route-Bucket
 *
 * Usage:
 *   node scripts/diagnose-nginx-route.mjs /var/log/nginx/access.log
 *   node scripts/diagnose-nginx-route.mjs --session sticky-test-001 /var/log/nginx/access.log
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROUTE_REASON_PATTERN = /X-Route-Reason[=:]\s*([A-Za-z0-9_-]+)/i;
const SELECTED_MODEL_PATTERN = /X-Selected-Model[=:]\s*([A-Za-z0-9._-]+)/i;
const ROUTE_BUCKET_PATTERN = /X-Route-Bucket[=:]\s*([A-Za-z0-9_-]+)/i;
const SESSION_PATTERN = /X-LYClaw-Session-Id[=:]\s*([^\s,"]+)/i;

function parseLine(line) {
  const selectedModel = line.match(SELECTED_MODEL_PATTERN)?.[1];
  const routeReason = line.match(ROUTE_REASON_PATTERN)?.[1];
  const routeBucket = line.match(ROUTE_BUCKET_PATTERN)?.[1];
  const sessionId = line.match(SESSION_PATTERN)?.[1];
  if (!selectedModel && !routeReason) return null;
  return { selectedModel, routeReason, routeBucket, sessionId, line };
}

function main() {
  const args = process.argv.slice(2);
  let sessionFilter = null;
  let logPath = null;

  if (args[0] === '--session') {
    sessionFilter = args[1] ?? null;
    logPath = args[2] ?? null;
  } else {
    logPath = args[0] ?? null;
  }

  if (!logPath) {
    console.error('Usage: node scripts/diagnose-nginx-route.mjs [--session <id>] <access.log>');
    process.exit(1);
  }

  const content = readFileSync(resolve(logPath), 'utf8');
  const entries = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (sessionFilter && !line.includes(sessionFilter)) continue;
    const parsed = parseLine(line);
    if (parsed) entries.push(parsed);
  }

  if (entries.length === 0) {
    console.log('No routing header entries found. Ensure access log records X-Selected-Model / X-Route-Reason.');
    process.exit(0);
  }

  const modelSwitches = [];
  for (let index = 1; index < entries.length; index += 1) {
    const prev = entries[index - 1];
    const curr = entries[index];
    if (prev.selectedModel && curr.selectedModel && prev.selectedModel !== curr.selectedModel) {
      modelSwitches.push({
        index: index + 1,
        from: prev.selectedModel,
        to: curr.selectedModel,
        reason: curr.routeReason,
      });
    }
  }

  const reasonCounts = new Map();
  for (const entry of entries) {
    const reason = entry.routeReason ?? 'unknown';
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  }

  console.log(`Parsed ${entries.length} routed request(s)`);
  console.log('Route reason counts:');
  for (const [reason, count] of reasonCounts.entries()) {
    console.log(`  ${reason}: ${count}`);
  }

  if (modelSwitches.length > 0) {
    console.log('\nModel switches (KV cache likely invalidated):');
    for (const sw of modelSwitches) {
      console.log(`  #${sw.index}: ${sw.from} -> ${sw.to} (${sw.reason ?? 'unknown'})`);
    }
  } else {
    console.log('\nNo backend model switches detected in log sample.');
  }

  console.log('\nRecent entries:');
  for (const entry of entries.slice(-10)) {
    console.log(
      [
        entry.sessionId ? `session=${entry.sessionId}` : null,
        entry.selectedModel ? `model=${entry.selectedModel}` : null,
        entry.routeReason ? `reason=${entry.routeReason}` : null,
        entry.routeBucket ? `bucket=${entry.routeBucket}` : null,
      ].filter(Boolean).join(' | '),
    );
  }
}

main();
