/**
 * LYClaw company skill marketplace CLI (技能广场).
 * Same Host API path as Skills UI — requires LYClaw running + host-api-bridge.json.
 *
 * Usage:
 *   lyclaw-marketplace search [--query text] [--category cat] [--sort -download_count]
 *   lyclaw-marketplace install <marketplace-id> [--version x.y.z]
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCliArgs } from './lyclaw-marketplace-args.mjs';

export { parseCliArgs } from './lyclaw-marketplace-args.mjs';

export const BRIDGE_PATH = join(homedir(), '.openclaw', '.lyclaw', 'host-api-bridge.json');

export async function readBridge() {
  const raw = await readFile(BRIDGE_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed?.baseUrl || !parsed?.token) {
    throw new Error(
      'LYClaw Host API bridge missing baseUrl/token. Start LYClaw and retry.',
    );
  }
  return parsed;
}

export async function hostApi(pathname, init = {}) {
  const bridge = await readBridge();
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${bridge.token}`,
    ...(init.headers || {}),
  };
  const response = await fetch(`${bridge.baseUrl}${pathname}`, { ...init, headers });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    const message = typeof data.error === 'string'
      ? data.error
      : `Host API ${response.status}`;
    throw new Error(message);
  }
  return data;
}

export async function searchSkills({ query = '', category = '', sort = '-download_count' } = {}) {
  return hostApi('/api/clawhub/search', {
    method: 'POST',
    body: JSON.stringify({ query, category, sort }),
  });
}

export async function installSkill({ slug, version, name }) {
  const installResult = await hostApi('/api/clawhub/install', {
    method: 'POST',
    body: JSON.stringify({ slug: String(slug), version }),
  });
  const packageSlug = installResult.slug || slug;
  await hostApi('/api/skills/enabled', {
    method: 'PUT',
    body: JSON.stringify({
      skillKey: packageSlug,
      slug: packageSlug,
      name: name || installResult.name || packageSlug,
      enabled: true,
    }),
  });
  return installResult;
}

export function printHelp() {
  process.stdout.write(`LYClaw skill marketplace CLI (company 技能广场)

Requires LYClaw running (uses ~/.openclaw/.lyclaw/host-api-bridge.json).

Commands:
  search [--query text] [--category cat] [--sort -download_count]
  install <marketplace-id> [--version x.y.z] [--name "Display Name"]

Examples:
  lyclaw-marketplace search --query "报销 excel"
  lyclaw-marketplace install 123
`);
}

async function main() {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (parsed.command === 'help') {
    printHelp();
    return;
  }

  if (parsed.command === 'search') {
    const result = await searchSkills(parsed.options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (parsed.command === 'install') {
    const slug = parsed.positional[0];
    if (!slug) {
      throw new Error('install requires marketplace id: lyclaw-marketplace install <id>');
    }
    const result = await installSkill({
      slug,
      version: parsed.options.version,
      name: parsed.options.name,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  throw new Error(`Unknown command: ${parsed.command}. Run with --help.`);
}

const isMain = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
