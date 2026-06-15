import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';
import {
  getMcpConfigPath,
  readMcpConfig,
  writeMcpConfigAtomic,
  mergeGithubInstall,
  mergeNotionInstall,
  LYCLAW_BUILTIN_MCP_KEYS,
} from '../../utils/mcp-json';
import { validateMcpConfig } from '../../utils/mcp-config-validator';
import { assertMcpServerAllowedWithConfirmation } from '../../security/confirmation-service';

function reloadGatewayMcp(ctx: HostApiContext): void {
  ctx.gatewayManager.debouncedReload();
}

export async function handleConnectorRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: HostApiContext,
): Promise<boolean> {
  const path = url.pathname;

  if (path === '/api/connectors' && req.method === 'GET') {
    sendJson(res, 200, []);
    return true;
  }

  if (path === '/api/connectors/install' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ id?: string; config?: Record<string, unknown> }>(req);
      const id = body.id?.trim();
      if (id !== 'notion' && id !== 'github') {
        sendJson(res, 400, { success: false, error: 'Unsupported connector id' });
        return true;
      }
      const mcpPath = getMcpConfigPath();
      const current = await readMcpConfig();
      let next = current;
      if (id === 'github') {
        const token = typeof body.config?.githubToken === 'string' ? body.config.githubToken.trim() : '';
        if (!token) {
          sendJson(res, 400, { success: false, error: 'githubToken is required' });
          return true;
        }
        next = mergeGithubInstall(current, token);
      } else {
        const key = typeof body.config?.notionApiKey === 'string' ? body.config.notionApiKey.trim() : '';
        if (!key) {
          sendJson(res, 400, { success: false, error: 'notionApiKey is required' });
          return true;
        }
        next = mergeNotionInstall(current, key);
      }
      const validation = validateMcpConfig(next);
      if (!validation.valid) {
        sendJson(res, 400, { success: false, errors: validation.errors });
        return true;
      }
      await assertMcpServerAllowedWithConfirmation({
        serverName: id,
        server: next.servers[id],
        source: 'settings:connector-install',
      });
      await writeMcpConfigAtomic(mcpPath, next);
      reloadGatewayMcp(ctx);
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (path.startsWith('/api/connectors/') && req.method === 'DELETE') {
    const rawId = path.slice('/api/connectors/'.length);
    const id = decodeURIComponent(rawId);
    if (!LYCLAW_BUILTIN_MCP_KEYS.has(id)) {
      sendJson(res, 400, { success: false, error: 'Only built-in notion/github entries can be removed via this endpoint' });
      return true;
    }
    try {
      const mcpPath = getMcpConfigPath();
      const current = await readMcpConfig();
      if (!current.servers[id]) {
        sendJson(res, 404, { success: false, error: 'Not installed' });
        return true;
      }
      const { [id]: _removed, ...rest } = current.servers;
      const next = { servers: rest };
      await writeMcpConfigAtomic(mcpPath, next);
      reloadGatewayMcp(ctx);
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (path.startsWith('/api/connectors/') && path.endsWith('/enable') && req.method === 'POST') {
    const raw = path.slice('/api/connectors/'.length, path.length - '/enable'.length);
    const id = decodeURIComponent(raw.replace(/\/$/, ''));
    if (!LYCLAW_BUILTIN_MCP_KEYS.has(id)) {
      sendJson(res, 400, { success: false, error: 'Unknown connector' });
      return true;
    }
    try {
      const mcpPath = getMcpConfigPath();
      const current = await readMcpConfig();
      if (!current.servers[id]) {
        sendJson(res, 404, { success: false, error: 'Not installed' });
        return true;
      }
      current.servers[id].disabled = false;
      await assertMcpServerAllowedWithConfirmation({
        serverName: id,
        server: current.servers[id],
        source: 'settings:connector-enable',
      });
      await writeMcpConfigAtomic(mcpPath, current);
      reloadGatewayMcp(ctx);
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (path.startsWith('/api/connectors/') && path.endsWith('/disable') && req.method === 'POST') {
    const raw = path.slice('/api/connectors/'.length, path.length - '/disable'.length);
    const id = decodeURIComponent(raw.replace(/\/$/, ''));
    if (!LYCLAW_BUILTIN_MCP_KEYS.has(id)) {
      sendJson(res, 400, { success: false, error: 'Unknown connector' });
      return true;
    }
    try {
      const mcpPath = getMcpConfigPath();
      const current = await readMcpConfig();
      if (!current.servers[id]) {
        sendJson(res, 404, { success: false, error: 'Not installed' });
        return true;
      }
      current.servers[id].disabled = true;
      await writeMcpConfigAtomic(mcpPath, current);
      reloadGatewayMcp(ctx);
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  return false;
}
