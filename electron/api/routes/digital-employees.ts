

import { listCompanyAgents } from '../../utils/company-agent-marketplace';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  InstallDigitalEmployeeInput,
  UninstallDigitalEmployeeInput,
  UpdateDigitalEmployeeInput,
} from '../../../shared/types/digital-employee';
import { installDigitalEmployee } from '../../services/digital-employee-installer';
import { updateDigitalEmployee } from '../../services/digital-employee-updater';
import { uninstallDigitalEmployee, uninstallDigitalEmployeeByMarketId } from '../../services/digital-employee-uninstaller';
import { listLocalDigitalEmployees, setDigitalEmployeeEnabled } from '../../utils/digital-employee-storage';
import { listAgentsSnapshot } from '../../utils/agent-config';

import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';

function reloadGatewayAfterDigitalEmployeeMutation(ctx: HostApiContext): void {
  ctx.gatewayManager.debouncedReload();
}

export async function handleDigitalEmployeeRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: HostApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/digital-employee/marketplace/list' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{
        query?: string;
        category?: string;
        sort?: string;
      }>(req);
      sendJson(res, 200, {
        success: true,
        results: await listCompanyAgents({
          query: typeof body.query === 'string' ? body.query : '',
          category: typeof body.category === 'string' ? body.category : '',
          sort: typeof body.sort === 'string' ? body.sort : '',
        }),
      });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/digital-employees' && req.method === 'GET') {
    try {
      const [employees, agentsSnapshot] = await Promise.all([
        listLocalDigitalEmployees(),
        listAgentsSnapshot(),
      ]);
      const agentIds = new Set(agentsSnapshot.agents.map((agent) => agent.id));
      sendJson(res, 200, employees.map((employee) => (
        agentIds.has(employee.agentId)
          ? employee
          : {
            ...employee,
            status: 'repair-required' as const,
            warnings: [...employee.warnings, 'The bound OpenClaw Agent is missing'],
          }
      )));
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/digital-employees/install' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<Partial<InstallDigitalEmployeeInput>>(req);
      const result = await installDigitalEmployee({
        marketEmployeeId: typeof body.marketEmployeeId === 'number'
        || typeof body.marketEmployeeId === 'string'
          ? String(body.marketEmployeeId).trim()
          : '',
        packageSha256: body.packageSha256?.trim() || undefined,
      });
      reloadGatewayAfterDigitalEmployeeMutation(ctx);
      sendJson(res, 200, { success: true, ...result });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/digital-employees/uninstall' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<Partial<UninstallDigitalEmployeeInput>>(req);
      const marketEmployeeId = typeof body.marketEmployeeId === 'number'
        || typeof body.marketEmployeeId === 'string'
        ? String(body.marketEmployeeId).trim()
        : '';
      const instanceId = typeof body.instanceId === 'string' ? body.instanceId.trim() : '';
      const result = marketEmployeeId
        ? await uninstallDigitalEmployeeByMarketId(marketEmployeeId)
        : instanceId
          ? await uninstallDigitalEmployee(instanceId)
          : (() => { throw new Error('marketEmployeeId or instanceId is required'); })();
      reloadGatewayAfterDigitalEmployeeMutation(ctx);
      sendJson(res, 200, { success: true, ...result });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  const updateMatch = url.pathname.match(/^\/api\/digital-employees\/([^/]+)\/update$/);
  if (updateMatch && req.method === 'POST') {
    try {
      const instanceId = decodeURIComponent(updateMatch[1]);
      const body = await parseJsonBody<Partial<UpdateDigitalEmployeeInput>>(req);
      const result = await updateDigitalEmployee(instanceId, {
        packageSha256: body.packageSha256?.trim() || undefined,
      });
      reloadGatewayAfterDigitalEmployeeMutation(ctx);
      sendJson(res, 200, { success: true, ...result });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  const enabledMatch = url.pathname.match(/^\/api\/digital-employees\/([^/]+)\/enabled$/);
  if (enabledMatch && req.method === 'PUT') {
    try {
      const instanceId = decodeURIComponent(enabledMatch[1]);
      const body = await parseJsonBody<{ enabled?: boolean }>(req);
      if (typeof body.enabled !== 'boolean') {
        sendJson(res, 400, { success: false, error: 'enabled must be a boolean' });
        return true;
      }
      const record = await setDigitalEmployeeEnabled(instanceId, body.enabled);
      sendJson(res, 200, {
        success: true,
        instanceId: record.instanceId,
        enabled: record.userEnabled !== false,
      });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  return false;
}
