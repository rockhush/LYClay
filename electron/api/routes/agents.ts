import type { IncomingMessage, ServerResponse } from 'http';
import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'path';
import {
  assignChannelToAgent,
  clearChannelBinding,
  createAgent,
  deleteAgentConfig,
  listAgentsSnapshot,
  removeAgentWorkspaceDirectory,
  resolveAccountIdForAgent,
  updateAgentModel,
  updateAgentName,
} from '../../utils/agent-config';
import { listDigitalEmployeeAgentIds } from '../../utils/digital-employee-storage';
import { deleteChannelAccountConfig } from '../../utils/channel-config';
import { syncAgentModelOverrideToRuntime, syncAllProviderAuthToRuntime } from '../../services/providers/provider-runtime-sync';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';
import { ensureClawXContext } from '../../utils/openclaw-workspace';
import { terminateGatewayListenersOnPort, terminateGatewayProcessByPid } from '../../gateway/supervisor';
import { listLocalDigitalEmployees, readInstalledManifest } from '../../utils/digital-employee-storage';
function scheduleGatewayReload(ctx: HostApiContext, reason: string): void {
  if (ctx.gatewayManager.getStatus().state !== 'stopped') {
    ctx.gatewayManager.debouncedReload();
    return;
  }
  void reason;
}

import { exec } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(exec);

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readDigitalEmployeeWorkflowPrompt(installPath: string): Promise<string | null> {
  const root = resolve(installPath);
  let workflowRelPath = 'workflows/default.md';

  try {
    const manifest = await readInstalledManifest(installPath);
    if (typeof manifest.execution?.workflow === 'string' && manifest.execution.workflow.trim()) {
      workflowRelPath = manifest.execution.workflow.trim();
    }
  } catch {
    // Fall back to the conventional default workflow path.
  }

  const workflowPath = resolve(root, workflowRelPath);
  if (workflowPath !== root && !workflowPath.startsWith(`${root}${process.platform === 'win32' ? '\\' : '/'}`)) {
    return null;
  }
  if (!(await pathExists(workflowPath))) return null;

  const content = await readFile(workflowPath, 'utf8');
  return content.trim() || null;
}

/**
 * Force a full Gateway process restart after agent deletion.
 *
 * A SIGUSR1 in-process reload is NOT sufficient here: channel plugins
 * (e.g. Feishu) maintain long-lived WebSocket connections to external
 * services and do not disconnect accounts that were removed from the
 * config during an in-process reload.  The only reliable way to drop
 * stale bot connections is to kill the Gateway process entirely and
 * spawn a fresh one that reads the updated openclaw.json from scratch.
 */
export async function restartGatewayForAgentDeletion(ctx: HostApiContext): Promise<void> {
  try {
    // 在 stop()/restart() 清理状态前先取出当前 Gateway 的 PID 和端口。
    const status = ctx.gatewayManager.getStatus();
    const pid = status.pid;
    const port = status.port;
    console.log('[agents] Triggering Gateway restart (kill+respawn) after agent deletion', { pid, port });

    // 删除 Agent 后必须完整重启 Gateway，避免通道插件继续保留旧连接。
    // 路由层不再直接拼接 taskkill/lsof/netstat；所有进程清理都交给
    // supervisor 的可信内部命令边界做参数校验和审计。
    if (pid) {
      try {
        await terminateGatewayProcessByPid(pid, 'system:agent-delete-gateway-restart');
      } catch {
        // process already gone – that's fine
      }
    } else if (port) {
      // 没有 PID 时按端口清理遗留 Gateway 监听进程，具体命令同样由 supervisor 收口。
      try {
        await terminateGatewayListenersOnPort(port);
      } catch {
        // Port might not be bound or command failed; ignore
      }
    }

    await ctx.gatewayManager.restart();
    console.log('[agents] Gateway restart completed after agent deletion');
  } catch (err) {
    console.warn('[agents] Gateway restart after agent deletion failed:', err);
  }
}

export async function handleAgentRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: HostApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/agents' && req.method === 'GET') {
    const snapshot = await listAgentsSnapshot();
    if (url.searchParams.get('scope') === 'managed') {
      const digitalEmployeeAgentIds = await listDigitalEmployeeAgentIds();
      sendJson(res, 200, {
        success: true,
        ...snapshot,
        agents: snapshot.agents.filter((agent) => !digitalEmployeeAgentIds.has(agent.id)),
      });
      return true;
    }
    sendJson(res, 200, { success: true, ...snapshot });
    return true;
  }

  if (url.pathname === '/api/agents/is-digital-employee' && req.method === 'GET') {
    const agentId = url.searchParams.get('agentId')?.trim();
    if (!agentId) {
      sendJson(res, 400, { success: false, error: 'Missing agentId' });
      return true;
    }

    const employees = await listLocalDigitalEmployees();
    const employee = employees.find((entry) => entry.agentId === agentId || entry.instanceId === agentId) ?? null;
    const workflowPrompt = employee
      ? await readDigitalEmployeeWorkflowPrompt(employee.installPath)
      : null;

    sendJson(res, 200, {
      success: true,
      isDigitalEmployee: Boolean(employee),
      instanceId: employee?.instanceId ?? null,
      installPath: employee?.installPath ?? null,
      name: employee?.name ?? null,
      workflowPrompt,
    });
    return true;
  }

  if (url.pathname === '/api/agents' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ name: string; inheritWorkspace?: boolean }>(req);
      const snapshot = await createAgent(body.name, { inheritWorkspace: body.inheritWorkspace });
      // Sync provider API keys to the new agent's auth-profiles.json so the
      // embedded runner can authenticate with LLM providers when messages
      // arrive via channel bots (e.g. Feishu). Without this, the copied
      // auth-profiles.json may contain a stale key → 401 from the LLM.
      syncAllProviderAuthToRuntime().catch((err) => {
        console.warn('[agents] Failed to sync provider auth after agent creation:', err);
      });
      scheduleGatewayReload(ctx, 'create-agent');
      // Ensure newly provisioned workspaces get LYClaw context merge/cleanup
      // even when gateway status events do not fire (e.g. in-process reload).
      void ensureClawXContext().catch((err) => {
        console.warn('[agents] Failed to ensure LYClaw context after agent creation:', err);
      });
      sendJson(res, 200, { success: true, ...snapshot });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname.startsWith('/api/agents/') && req.method === 'PUT') {
    const suffix = url.pathname.slice('/api/agents/'.length);
    const parts = suffix.split('/').filter(Boolean);

    if (parts.length === 1) {
      try {
        const body = await parseJsonBody<{ name: string }>(req);
        const agentId = decodeURIComponent(parts[0]);
        const snapshot = await updateAgentName(agentId, body.name);
        scheduleGatewayReload(ctx, 'update-agent');
        sendJson(res, 200, { success: true, ...snapshot });
      } catch (error) {
        sendJson(res, 500, { success: false, error: String(error) });
      }
      return true;
    }

    if (parts.length === 2 && parts[1] === 'model') {
      try {
        const body = await parseJsonBody<{ modelRef?: string | null }>(req);
        const agentId = decodeURIComponent(parts[0]);
        const snapshot = await updateAgentModel(agentId, body.modelRef ?? null);
        try {
          await syncAllProviderAuthToRuntime();
          // Ensure this agent's runtime model registry reflects the new model override.
          await syncAgentModelOverrideToRuntime(agentId);
        } catch (syncError) {
          console.warn('[agents] Failed to sync runtime after updating agent model:', syncError);
        }

        // 热更新：直接通过 RPC 让 Gateway 更新模型配置，无需重启
        let gatewayUpdated = false;
        const effectiveModelRef = snapshot.agents.find((agent) => agent.id === agentId)?.modelRef;
        if (ctx.gatewayManager.isConnected() && effectiveModelRef) {
          try {
            await ctx.gatewayManager.rpc('agents.update', {
              agentId,
              model: effectiveModelRef,
            }, 10000);
            gatewayUpdated = true;
            console.log('[agents] Gateway model hot-reloaded via agents.update RPC');
          } catch (rpcError) {
            console.warn('[agents] Gateway agents.update RPC failed, fallback to reload:', rpcError);
            // RPC 失败时 fallback 到原有的 reload 逻辑
            scheduleGatewayReload(ctx, 'update-agent-model-fallback');
          }
        }

        sendJson(res, 200, { success: true, ...snapshot, gatewayUpdated });
      } catch (error) {
        sendJson(res, 500, { success: false, error: String(error) });
      }
      return true;
    }

    if (parts.length === 3 && parts[1] === 'channels') {
      try {
        const agentId = decodeURIComponent(parts[0]);
        const channelType = decodeURIComponent(parts[2]);
        const snapshot = await assignChannelToAgent(agentId, channelType);
        scheduleGatewayReload(ctx, 'assign-channel');
        sendJson(res, 200, { success: true, ...snapshot });
      } catch (error) {
        sendJson(res, 500, { success: false, error: String(error) });
      }
      return true;
    }
  }

  if (url.pathname.startsWith('/api/agents/') && req.method === 'DELETE') {
    const suffix = url.pathname.slice('/api/agents/'.length);
    const parts = suffix.split('/').filter(Boolean);

    if (parts.length === 1) {
      try {
        const agentId = decodeURIComponent(parts[0]);
        const { snapshot, removedEntry } = await deleteAgentConfig(agentId);
        // Await reload synchronously BEFORE responding to the client.
        // This ensures the Feishu plugin has disconnected the deleted bot
        // before the UI shows "delete success" and the user tries chatting.
        await restartGatewayForAgentDeletion(ctx);
        // Delete workspace after reload so the new config is already live.
        await removeAgentWorkspaceDirectory(removedEntry).catch((err) => {
          console.warn('[agents] Failed to remove workspace after agent deletion:', err);
        });
        sendJson(res, 200, { success: true, ...snapshot });
      } catch (error) {
        sendJson(res, 500, { success: false, error: String(error) });
      }
      return true;
    }

    if (parts.length === 3 && parts[1] === 'channels') {
      try {
        const agentId = decodeURIComponent(parts[0]);
        const channelType = decodeURIComponent(parts[2]);
        const ownerId = agentId.trim().toLowerCase();
        const snapshotBefore = await listAgentsSnapshot();
        const ownedAccountIds = Object.entries(snapshotBefore.channelAccountOwners)
          .filter(([channelAccountKey, owner]) => {
            if (owner !== ownerId) return false;
            return channelAccountKey.startsWith(`${channelType}:`);
          })
          .map(([channelAccountKey]) => channelAccountKey.slice(channelAccountKey.indexOf(':') + 1));
        // Backward compatibility for legacy agentId->accountId mapping.
        if (ownedAccountIds.length === 0) {
          const legacyAccountId = resolveAccountIdForAgent(agentId);
          if (snapshotBefore.channelAccountOwners[`${channelType}:${legacyAccountId}`] === ownerId) {
            ownedAccountIds.push(legacyAccountId);
          }
        }

        for (const accountId of ownedAccountIds) {
          await deleteChannelAccountConfig(channelType, accountId);
          await clearChannelBinding(channelType, accountId);
        }
        const snapshot = await listAgentsSnapshot();
        scheduleGatewayReload(ctx, 'remove-agent-channel');
        sendJson(res, 200, { success: true, ...snapshot });
      } catch (error) {
        sendJson(res, 500, { success: false, error: String(error) });
      }
      return true;
    }
  }

  return false;
}
