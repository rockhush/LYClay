import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';
import { assertCommandAllowedWithConfirmation } from '../../security/confirmation-service';
import {
  grantDomainAccess,
  listAllCommandGrants,
  listAllDomainGrants,
  listAllMcpServerGrants,
  listAllPathGrants,
  listAllSkillGrants,
  revokeCommandGrant,
  revokeDomainGrant,
  revokeMcpServerGrant,
  revokePathGrant,
  revokeSkillGrant,
} from '../../security/permission-store';
import { assertSkillRuntimeCommandAllowed } from '../../security/skill-runtime-policy';
import { querySecurityAuditEventPage, querySecurityAuditEvents } from '../../security/audit-log';
import type { NetworkCapability, SecurityAuditCapability, SecurityAuditDecision } from '../../security/types';
import { inferSkillContextFromCommand } from '../../gateway/exec-approval-bridge';

function decodeId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export async function handleSecurityRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  _ctx: HostApiContext,
): Promise<boolean> {
  const path = url.pathname;

  if (path === '/api/security/command-policy/preflight' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{
        command?: string;
        cwd?: string;
        agentId?: string;
        sessionKey?: string;
        source?: string;
      }>(req);
      const command = typeof body.command === 'string' ? body.command.trim() : '';
      const cwd = typeof body.cwd === 'string' && body.cwd.trim() ? body.cwd.trim() : undefined;
      if (!command) {
        sendJson(res, 400, { success: false, error: 'command is required' });
        return true;
      }

      const inferredSkill = await inferSkillContextFromCommand(command, cwd);
      if (inferredSkill) {
        const result = await assertSkillRuntimeCommandAllowed({
          kind: 'command',
          context: {
            ...inferredSkill,
            source: `gateway:runtime-exec:skill:${inferredSkill.skillId}`,
          },
          command,
          cwd,
        });
        sendJson(res, 200, { success: true, result });
        return true;
      }

      const result = await assertCommandAllowedWithConfirmation({
        command,
        cwd,
        source: typeof body.source === 'string' && body.source.trim()
          ? body.source.trim()
          : body.agentId
            ? `gateway:runtime-exec:${body.agentId}`
            : 'gateway:runtime-exec',
      });
      sendJson(res, 200, { success: true, result });
    } catch (error) {
      const err = error as Error & { code?: string; decision?: unknown };
      sendJson(res, 403, {
        success: false,
        error: err.message || String(error),
        code: err.code,
        decision: err.decision,
      });
    }
    return true;
  }

  if (path === '/api/security/audit-events' && req.method === 'GET') {
    try {
      const limitRaw = Number(url.searchParams.get('limit') ?? '100');
      const limit = Number.isFinite(limitRaw) ? limitRaw : 100;
      const capability = url.searchParams.get('capability') as SecurityAuditCapability | null;
      const decision = url.searchParams.get('decision') as SecurityAuditDecision | null;
      const source = url.searchParams.get('source') ?? undefined;
      const pageRaw = Number(url.searchParams.get('page') ?? '1');
      const pageSizeRaw = Number(url.searchParams.get('pageSize') ?? '10');
      const usesPagination = url.searchParams.has('page') || url.searchParams.has('pageSize');
      if (usesPagination) {
        const result = querySecurityAuditEventPage({
          page: Number.isFinite(pageRaw) ? pageRaw : 1,
          pageSize: Number.isFinite(pageSizeRaw) ? pageSizeRaw : 10,
          ...(capability ? { capability } : {}),
          ...(decision ? { decision } : {}),
          ...(source ? { source } : {}),
        });
        sendJson(res, 200, { success: true, ...result });
        return true;
      }
      const events = querySecurityAuditEvents({
        limit,
        ...(capability ? { capability } : {}),
        ...(decision ? { decision } : {}),
        ...(source ? { source } : {}),
      });
      sendJson(res, 200, { success: true, events });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (path === '/api/security/grants' && req.method === 'GET') {
    try {
      const [pathGrants, domainGrants, commandGrants, mcpServerGrants, skillGrants] = await Promise.all([
        listAllPathGrants(),
        listAllDomainGrants(),
        listAllCommandGrants(),
        listAllMcpServerGrants(),
        listAllSkillGrants(),
      ]);
      sendJson(res, 200, { pathGrants, domainGrants, commandGrants, mcpServerGrants, skillGrants });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (path === '/api/security/grants/domain' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{
        domain?: string;
        includeSubdomains?: boolean;
        persistent?: boolean;
      }>(req);
      const domain = typeof body.domain === 'string' ? body.domain.trim() : '';
      if (!domain) {
        sendJson(res, 400, { success: false, error: 'domain is required' });
        return true;
      }
      const grant = await grantDomainAccess(domain, {
        capabilities: ['connect'] satisfies NetworkCapability[],
        includeSubdomains: body.includeSubdomains ?? true,
        persistent: body.persistent ?? true,
        source: 'settings:security',
      });
      sendJson(res, 200, { success: true, grant });
    } catch (error) {
      sendJson(res, 400, { success: false, error: String(error) });
    }
    return true;
  }

  const revokePathMatch = /^\/api\/security\/grants\/path\/(.+)$/.exec(path);
  if (revokePathMatch && req.method === 'DELETE') {
    try {
      const revoked = await revokePathGrant(decodeId(revokePathMatch[1]));
      if (!revoked) {
        sendJson(res, 404, { success: false, error: 'Path grant not found' });
        return true;
      }
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  const revokeDomainMatch = /^\/api\/security\/grants\/domain\/(.+)$/.exec(path);
  if (revokeDomainMatch && req.method === 'DELETE') {
    try {
      const revoked = await revokeDomainGrant(decodeId(revokeDomainMatch[1]));
      if (!revoked) {
        sendJson(res, 404, { success: false, error: 'Domain grant not found' });
        return true;
      }
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  const revokeCommandMatch = /^\/api\/security\/grants\/command\/(.+)$/.exec(path);
  if (revokeCommandMatch && req.method === 'DELETE') {
    try {
      const revoked = await revokeCommandGrant(decodeId(revokeCommandMatch[1]));
      if (!revoked) {
        sendJson(res, 404, { success: false, error: 'Command grant not found' });
        return true;
      }
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  const revokeMcpServerMatch = /^\/api\/security\/grants\/mcp-server\/(.+)$/.exec(path);
  if (revokeMcpServerMatch && req.method === 'DELETE') {
    try {
      const revoked = await revokeMcpServerGrant(decodeId(revokeMcpServerMatch[1]));
      if (!revoked) {
        sendJson(res, 404, { success: false, error: 'MCP server grant not found' });
        return true;
      }
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  const revokeSkillMatch = /^\/api\/security\/grants\/skill\/(.+)$/.exec(path);
  if (revokeSkillMatch && req.method === 'DELETE') {
    try {
      const revoked = await revokeSkillGrant(decodeId(revokeSkillMatch[1]));
      if (!revoked) {
        sendJson(res, 404, { success: false, error: 'Skill grant not found' });
        return true;
      }
      sendJson(res, 200, { success: true });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  return false;
}
