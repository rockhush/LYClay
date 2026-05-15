import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';
import {
  getMcpConfigPath,
  readMcpConfig,
  writeMcpConfigAtomic,
  LYCLAW_BUILTIN_MCP_KEYS,
  type McpServerEntry,
} from '../../utils/mcp-json';
import { coerceMcpConfig, validateMcpConfig } from '../../utils/mcp-config-validator';
import { fetchGatewayToolNamesForServer } from '../../utils/mcp-gateway-tools';

function reloadGatewayMcp(ctx: HostApiContext): void {
  ctx.gatewayManager.debouncedReload();
}

function decodeServerName(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function readToolsFilter(server: McpServerEntry): { allow?: string[]; deny: string[] } {
  const t = server.tools;
  if (!t || typeof t !== 'object' || Array.isArray(t)) return { deny: [] };
  const deny = Array.isArray(t.deny) ? t.deny.filter((x): x is string => typeof x === 'string') : [];
  const allow = Array.isArray(t.allow) ? t.allow.filter((x): x is string => typeof x === 'string') : undefined;
  return { allow: allow?.length ? allow : undefined, deny };
}

function mergeToolInventory(
  discovered: string[],
  allow: string[] | undefined,
  deny: string[],
): string[] {
  const set = new Set<string>();
  for (const n of discovered) set.add(n);
  for (const n of deny) set.add(n);
  if (allow?.length) {
    for (const n of allow) set.add(n);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

export async function handleMcpRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: HostApiContext,
): Promise<boolean> {
  const path = url.pathname;

  if (path === '/api/mcp/servers' && req.method === 'GET') {
    try {
      const config = await readMcpConfig();
      const list = Object.entries(config.servers).map(([name, server]) => {
        const { allow, deny } = readToolsFilter(server);
        return {
          name,
          enabled: server.disabled !== true,
          connected: false,
          toolCount: 0,
          totalTools: 0,
          type: server.type ?? server.transport ?? (server.command ? 'stdio' : undefined),
          url: server.url,
          command: server.command,
          deniedTools: deny,
          allowedTools: allow,
        };
      });
      sendJson(res, 200, list);
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  const getToolsMatch = /^\/api\/mcp\/servers\/([^/]+)\/tools$/.exec(path);
  if (getToolsMatch && req.method === 'GET') {
    const name = decodeServerName(getToolsMatch[1]);
    try {
      const config = await readMcpConfig();
      const server = config.servers[name];
      if (!server) {
        sendJson(res, 404, { success: false, error: `Unknown MCP server: ${name}` });
        return true;
      }
      const { allow, deny } = readToolsFilter(server);
      let discovered: string[] = [];
      try {
        discovered = await fetchGatewayToolNamesForServer(ctx.gatewayManager, name);
      } catch {
        discovered = [];
      }
      const tools = mergeToolInventory(discovered, allow, deny);
      sendJson(res, 200, { tools, denied: deny, allowed: allow ?? null, gateway: discovered.length > 0 });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  const postDenyMatch = /^\/api\/mcp\/servers\/([^/]+)\/tools\/deny$/.exec(path);
  if (postDenyMatch && req.method === 'POST') {
    const name = decodeServerName(postDenyMatch[1]);
    try {
      const body = await parseJsonBody<{ toolName?: string }>(req);
      const toolName = typeof body.toolName === 'string' ? body.toolName.trim() : '';
      if (!toolName) {
        sendJson(res, 400, { success: false, error: 'toolName is required' });
        return true;
      }
      const config = await readMcpConfig();
      const server = config.servers[name];
      if (!server) {
        sendJson(res, 404, { success: false, error: `Unknown MCP server: ${name}` });
        return true;
      }
      const prev = readToolsFilter(server);
      const deny = [...new Set([...prev.deny, toolName])];
      const nextTools: McpServerEntry['tools'] = { ...(server.tools ?? {}), deny };
      if (prev.allow?.length) {
        const na = prev.allow.filter((t) => t !== toolName);
        if (na.length) nextTools.allow = na;
        else delete nextTools.allow;
      }
      config.servers[name] = { ...server, tools: nextTools };
      const check = validateMcpConfig(config);
      if (!check.valid) {
        sendJson(res, 400, { success: false, errors: check.errors });
        return true;
      }
      await writeMcpConfigAtomic(getMcpConfigPath(), config);
      reloadGatewayMcp(ctx);
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  const deleteDenyMatch = /^\/api\/mcp\/servers\/([^/]+)\/tools\/deny\/(.+)$/.exec(path);
  if (deleteDenyMatch && req.method === 'DELETE') {
    const name = decodeServerName(deleteDenyMatch[1]);
    const toolName = decodeServerName(deleteDenyMatch[2]);
    try {
      const config = await readMcpConfig();
      const server = config.servers[name];
      if (!server) {
        sendJson(res, 404, { success: false, error: `Unknown MCP server: ${name}` });
        return true;
      }
      const prev = readToolsFilter(server);
      const deny = prev.deny.filter((t) => t !== toolName);
      const nextTools: McpServerEntry['tools'] = { ...(server.tools ?? {}) };
      if (deny.length) nextTools.deny = deny;
      else delete nextTools.deny;
      if (!nextTools.allow && !nextTools.deny) {
        const { tools: _t, ...rest } = server;
        config.servers[name] = rest as McpServerEntry;
      } else {
        config.servers[name] = { ...server, tools: nextTools };
      }
      const check = validateMcpConfig(config);
      if (!check.valid) {
        sendJson(res, 400, { success: false, errors: check.errors });
        return true;
      }
      await writeMcpConfigAtomic(getMcpConfigPath(), config);
      reloadGatewayMcp(ctx);
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  const deleteServerMatch = /^\/api\/mcp\/servers\/([^/]+)$/.exec(path);
  if (deleteServerMatch && req.method === 'DELETE') {
    const name = decodeServerName(deleteServerMatch[1]);
    if (LYCLAW_BUILTIN_MCP_KEYS.has(name)) {
      sendJson(res, 400, { success: false, error: 'Remove built-in notion/github via Connectors uninstall API' });
      return true;
    }
    try {
      const config = await readMcpConfig();
      if (!config.servers[name]) {
        sendJson(res, 404, { success: false, error: `Unknown MCP server: ${name}` });
        return true;
      }
      const { [name]: _removed, ...rest } = config.servers;
      const next = { servers: rest };
      const check = validateMcpConfig(next);
      if (!check.valid) {
        sendJson(res, 400, { success: false, errors: check.errors });
        return true;
      }
      await writeMcpConfigAtomic(getMcpConfigPath(), next);
      reloadGatewayMcp(ctx);
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (path.startsWith('/api/mcp/servers/') && path.endsWith('/enable') && req.method === 'POST') {
    const match = /^\/api\/mcp\/servers\/(.+)\/enable$/.exec(path);
    if (!match) return false;
    const ename = decodeServerName(match[1]);
    try {
      const config = await readMcpConfig();
      if (!config.servers[ename]) {
        sendJson(res, 404, { success: false, error: `Unknown MCP server: ${ename}` });
        return true;
      }
      config.servers[ename].disabled = false;
      const check = validateMcpConfig(config);
      if (!check.valid) {
        sendJson(res, 400, { success: false, errors: check.errors });
        return true;
      }
      await writeMcpConfigAtomic(getMcpConfigPath(), config);
      reloadGatewayMcp(ctx);
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (path.startsWith('/api/mcp/servers/') && path.endsWith('/disable') && req.method === 'POST') {
    const match = /^\/api\/mcp\/servers\/(.+)\/disable$/.exec(path);
    if (!match) return false;
    const dname = decodeServerName(match[1]);
    try {
      const config = await readMcpConfig();
      if (!config.servers[dname]) {
        sendJson(res, 404, { success: false, error: `Unknown MCP server: ${dname}` });
        return true;
      }
      config.servers[dname].disabled = true;
      await writeMcpConfigAtomic(getMcpConfigPath(), config);
      reloadGatewayMcp(ctx);
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (path === '/api/mcp/config' && req.method === 'GET') {
    try {
      const config = await readMcpConfig();
      sendJson(res, 200, { config, path: getMcpConfigPath() });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (path === '/api/mcp/config' && req.method === 'PUT') {
    try {
      const body = await parseJsonBody<{ config?: unknown }>(req);
      if (body.config === undefined) {
        sendJson(res, 400, { success: false, error: 'Missing config' });
        return true;
      }
      const coerced = coerceMcpConfig(body.config);
      const validation = validateMcpConfig(coerced);
      if (!validation.valid) {
        sendJson(res, 400, { success: false, errors: validation.errors });
        return true;
      }
      await writeMcpConfigAtomic(getMcpConfigPath(), coerced);
      reloadGatewayMcp(ctx);
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (path === '/api/mcp/config/validate' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ config?: unknown }>(req);
      if (body.config === undefined) {
        sendJson(res, 400, { valid: false, errors: ['Missing config'] });
        return true;
      }
      const result = validateMcpConfig(body.config);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  return false;
}
