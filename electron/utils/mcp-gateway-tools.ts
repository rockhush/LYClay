import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { GatewayManager } from '../gateway/manager';
import { redactSecrets } from '../security/secret-scanner';
import type { McpServerEntry } from './mcp-json';
import { validateMcpConfigNetworkPolicy } from './mcp-config-validator';
import { logger } from './logger';

const GATEWAY_CATALOG_TIMEOUT_MS = 3000;
const DIRECT_DISCOVERY_TIMEOUT_MS = 10_000;
const MAX_TOOL_PAGES = 20;

export type McpToolDiscoverySource = 'gateway' | 'direct' | 'unavailable';

export interface McpToolDiscoveryResult {
  tools: string[];
  source: McpToolDiscoverySource;
  error?: string;
}

function isToolishName(name: string): boolean {
  return name.length >= 1 && name.length <= 256 && /^[\w.-]+$/.test(name);
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

function toolNamesFromArray(value: unknown[]): string[] {
  return [...new Set(value
    .map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string') {
        return (item as { name: string }).name;
      }
      return '';
    })
    .filter((name) => name && isToolishName(name)))]
    .sort();
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
    const tools = e.toolNames ?? e.tools;
    if (Array.isArray(tools)) return toolNamesFromArray(tools);
  }
  return null;
}

function extractNamespacedTools(raw: unknown, serverName: string): string[] {
  const all = new Set<string>();
  walkToolNames(raw, all);
  const prefixes = [`${serverName}_`, `${serverName}.`];
  return [...new Set([...all].flatMap((name) => {
    const prefix = prefixes.find((candidate) => name.startsWith(candidate));
    if (!prefix) return [];
    const unprefixed = name.slice(prefix.length);
    return isToolishName(unprefixed) ? [unprefixed] : [];
  }))].sort();
}

const CATALOG_METHODS = ['tools.catalog', 'tools.list', 'plugins.tools.list', 'mcp.tools.catalog'] as const;

async function discoverFromGateway(
  gatewayManager: GatewayManager,
  serverName: string,
): Promise<McpToolDiscoveryResult | null> {
  const results = await Promise.all(CATALOG_METHODS.map(async (method) => {
    try {
      return await gatewayManager.rpc<unknown>(method, {}, GATEWAY_CATALOG_TIMEOUT_MS);
    } catch (error) {
      logger.debug(`[mcp-tools] ${method} failed for server=${serverName}: ${redactSecrets(String(error))}`);
      return null;
    }
  }));

  for (const raw of results) {
    if (raw == null) continue;
    const byBucket = tryExtractByServerContainer(raw, serverName);
    if (byBucket !== null) return { tools: byBucket, source: 'gateway' };
    const namespaced = extractNamespacedTools(raw, serverName);
    if (namespaced.length > 0) return { tools: namespaced, source: 'gateway' };
  }
  return null;
}

function getRemoteTransport(server: McpServerEntry): 'sse' | 'streamable-http' | null {
  const transport = server.type ?? server.transport;
  return transport === 'sse' || transport === 'streamable-http' ? transport : null;
}

function fetchWithConfiguredHeaders(headers?: Record<string, string>): typeof fetch {
  return async (input, init) => {
    const merged = new Headers(headers);
    new Headers(init?.headers).forEach((value, key) => merged.set(key, value));
    return fetch(input, { ...init, headers: merged });
  };
}

async function discoverDirectly(
  serverName: string,
  server: McpServerEntry,
): Promise<McpToolDiscoveryResult> {
  if (server.disabled === true) {
    return {
      tools: [],
      source: 'unavailable',
      error: 'Enable this MCP server before discovering its tools',
    };
  }

  const transportType = getRemoteTransport(server);
  if (!transportType || !server.url) {
    return {
      tools: [],
      source: 'unavailable',
      error: 'Gateway did not expose a per-server tool catalog',
    };
  }

  const networkCheck = await validateMcpConfigNetworkPolicy({ servers: { [serverName]: server } });
  if (!networkCheck.valid) {
    return {
      tools: [],
      source: 'unavailable',
      error: networkCheck.errors.join('; '),
    };
  }

  const client = new Client({ name: 'lyclaw-tool-discovery', version: '1.0.0' }, { capabilities: {} });
  const configuredFetch = fetchWithConfiguredHeaders(server.headers);
  const requestInit = { headers: server.headers } satisfies RequestInit;
  const transport = transportType === 'sse'
    ? new SSEClientTransport(new URL(server.url), { fetch: configuredFetch, requestInit })
    : new StreamableHTTPClientTransport(new URL(server.url), { fetch: configuredFetch, requestInit });
  const aborter = new AbortController();
  const timer = setTimeout(() => aborter.abort(), DIRECT_DISCOVERY_TIMEOUT_MS);

  try {
    await client.connect(transport, {
      signal: aborter.signal,
      timeout: DIRECT_DISCOVERY_TIMEOUT_MS,
      maxTotalTimeout: DIRECT_DISCOVERY_TIMEOUT_MS,
    });
    const names = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
      const result = await client.listTools(cursor ? { cursor } : undefined, {
        signal: aborter.signal,
        timeout: DIRECT_DISCOVERY_TIMEOUT_MS,
        maxTotalTimeout: DIRECT_DISCOVERY_TIMEOUT_MS,
      });
      for (const tool of result.tools) {
        if (isToolishName(tool.name)) names.add(tool.name);
      }
      cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
      if (!cursor || cursors.has(cursor)) break;
      cursors.add(cursor);
    }
    return { tools: [...names].sort(), source: 'direct' };
  } catch (error) {
    return {
      tools: [],
      source: 'unavailable',
      error: redactSecrets(String(error)),
    };
  } finally {
    clearTimeout(timer);
    aborter.abort();
    await client.close().catch(() => undefined);
  }
}

/**
 * Resolve an inventory attributable to exactly one MCP server.
 * Unscoped Gateway catalogs are never returned as per-server tools.
 */
export async function discoverMcpToolsForServer(
  gatewayManager: GatewayManager,
  serverName: string,
  server: McpServerEntry,
): Promise<McpToolDiscoveryResult> {
  const gateway = await discoverFromGateway(gatewayManager, serverName);
  if (gateway) return gateway;
  return discoverDirectly(serverName, server);
}
