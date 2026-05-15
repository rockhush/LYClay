import type { GatewayManager } from '../gateway/manager';
import { logger } from './logger';

function isToolishName(name: string): boolean {
  return name.length >= 2 && name.length <= 256 && /^[\w.\-]+$/.test(name);
}

/** Collect candidate tool names from nested Gateway payloads. */
function walkToolNames(value: unknown, out: Set<string>): void {
  if (value == null) return;
  if (typeof value === 'string') {
    if (isToolishName(value) && value.includes('_')) out.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walkToolNames(item, out);
    return;
  }
  if (typeof value !== 'object') return;
  const o = value as Record<string, unknown>;
  if (typeof o.name === 'string' && isToolishName(o.name)) {
    const maybeTool = 'description' in o || 'inputSchema' in o || 'input_schema' in o || 'parameters' in o
      || o.name.includes('_');
    if (maybeTool) out.add(o.name);
  }
  for (const v of Object.values(o)) walkToolNames(v, out);
}

function tryExtractByServerContainer(raw: unknown, serverName: string): string[] | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const buckets = [r.servers, r.mcpServers, (r.mcp as Record<string, unknown> | undefined)?.servers]
    .filter(Boolean) as Record<string, unknown>[];
  for (const servers of buckets) {
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) continue;
    const entry = servers[serverName];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    const tn = e.toolNames ?? e.tools;
    if (Array.isArray(tn)) {
      const names = tn
        .map((x) => {
          if (typeof x === 'string') return x;
          if (x && typeof x === 'object' && typeof (x as { name?: unknown }).name === 'string') {
            return (x as { name: string }).name;
          }
          return '';
        })
        .filter((n) => n && isToolishName(n));
      if (names.length) return [...new Set(names)].sort();
    }
  }
  return null;
}

function filterForServer(all: Set<string>, serverName: string): string[] {
  const arr = [...all];
  const prefixed = arr.filter((n) => n.startsWith(`${serverName}_`) || n.startsWith(`${serverName}.`));
  if (prefixed.length) return [...new Set(prefixed)].sort();
  if (arr.length > 0 && arr.length <= 96) return [...new Set(arr)].sort();
  return [];
}

const CATALOG_METHODS = ['tools.catalog', 'tools.list', 'plugins.tools.list', 'mcp.tools.catalog'] as const;

/**
 * Best-effort: ask OpenClaw Gateway for a tool catalog and pick names for this MCP server.
 */
export async function fetchGatewayToolNamesForServer(
  gatewayManager: GatewayManager,
  serverName: string,
): Promise<string[]> {
  for (const method of CATALOG_METHODS) {
    try {
      const raw = await gatewayManager.rpc<unknown>(method, {}, 8000);
      const byBucket = tryExtractByServerContainer(raw, serverName);
      if (byBucket?.length) return byBucket;
      const bag = new Set<string>();
      walkToolNames(raw, bag);
      const filtered = filterForServer(bag, serverName);
      if (filtered.length) return filtered;
    } catch (error) {
      logger.debug(`[mcp-tools] ${method} failed for server=${serverName}: ${String(error)}`);
    }
  }
  return [];
}
