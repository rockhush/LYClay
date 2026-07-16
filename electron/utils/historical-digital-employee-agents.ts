import { cp, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readOpenClawConfig, writeOpenClawConfig } from './channel-config';
import { withConfigLock } from './config-mutex';
import { listLocalDigitalEmployees } from './digital-employee-storage';
import { getOpenClawConfigDir } from './paths';
import {
  directoryHasSessionArtifacts,
  getActiveAgentSessionsDir,
  getRetiredAgentSessionsDir,
} from './retired-agent-sessions';
import * as logger from './logger';

const RETIRED_AGENTS_DIR = '_retired';

type AgentListEntry = {
  id: string;
  name?: string;
  workspace?: string;
  agentDir?: string;
  model?: string | Record<string, unknown>;
};

function extractDigitalEmployeePackageSlug(agentId: string): string | null {
  if (!agentId.startsWith('employee-')) return null;
  const body = agentId.slice('employee-'.length);
  const match = body.match(/^(.+)-[a-z0-9]{4,12}$/i);
  return match?.[1]?.trim() || null;
}

function parseAgentIdFromSessionKey(sessionKey: string): string | null {
  if (!sessionKey.startsWith('agent:')) return null;
  const [, agentId] = sessionKey.split(':');
  return agentId?.trim() || null;
}

function getAgentEntries(config: Record<string, unknown>): AgentListEntry[] {
  const agents = config.agents as { list?: AgentListEntry[] } | undefined;
  return Array.isArray(agents?.list) ? agents.list : [];
}

async function listRetiredDigitalEmployeeAgentIds(): Promise<string[]> {
  const retiredRoot = join(getOpenClawConfigDir(), 'agents', RETIRED_AGENTS_DIR);
  try {
    const entries = await readdir(retiredRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((agentId) => agentId.startsWith('employee-'));
  } catch {
    return [];
  }
}

async function restoreHistoricalAgentSessionsIfNeeded(agentId: string): Promise<boolean> {
  const retiredDir = getRetiredAgentSessionsDir(agentId);
  const activeDir = getActiveAgentSessionsDir(agentId);
  if (!(await directoryHasSessionArtifacts(retiredDir))) {
    return false;
  }
  if (await directoryHasSessionArtifacts(activeDir)) {
    return false;
  }

  await mkdir(activeDir, { recursive: true });
  await cp(retiredDir, activeDir, { recursive: true, force: true });
  logger.info('Restored historical digital employee sessions from retired archive', {
    agentId,
    retiredDir,
    activeDir,
  });
  return true;
}

async function ensureHistoricalAgentProxyEntry(
  historicalAgentId: string,
  activeEntry: AgentListEntry,
  displayName: string,
): Promise<boolean> {
  return withConfigLock(async () => {
    const config = await readOpenClawConfig() as Record<string, unknown>;
    const agentsConfig = (config.agents && typeof config.agents === 'object'
      ? config.agents
      : {}) as Record<string, unknown>;
    const entries = getAgentEntries(config);
    const existingIndex = entries.findIndex((entry) => entry.id === historicalAgentId);
    const nextEntry: AgentListEntry = {
      ...(existingIndex >= 0 ? entries[existingIndex] : {}),
      id: historicalAgentId,
      name: entries[existingIndex]?.name || displayName,
      workspace: activeEntry.workspace,
      agentDir: `~/.openclaw/agents/${historicalAgentId}/agent`,
      ...(activeEntry.model ? { model: activeEntry.model } : {}),
    };

    const alreadyCompatible = existingIndex >= 0
      && entries[existingIndex].workspace === nextEntry.workspace
      && JSON.stringify(entries[existingIndex].model ?? null) === JSON.stringify(nextEntry.model ?? null);
    if (alreadyCompatible) {
      await mkdir(getActiveAgentSessionsDir(historicalAgentId), { recursive: true });
      return false;
    }

    const nextEntries = existingIndex >= 0
      ? entries.map((entry, index) => (index === existingIndex ? nextEntry : entry))
      : [...entries, nextEntry];

    config.agents = {
      ...agentsConfig,
      list: nextEntries,
    };
    await writeOpenClawConfig(config);
    await mkdir(getActiveAgentSessionsDir(historicalAgentId), { recursive: true });
    logger.info('Ensured historical digital employee proxy agent config', {
      historicalAgentId,
      activeAgentId: activeEntry.id,
    });
    return true;
  });
}

export async function reactivateHistoricalDigitalEmployeeAgentsForActive(
  activeAgentId: string,
  displayName: string,
): Promise<string[]> {
  const packageSlug = extractDigitalEmployeePackageSlug(activeAgentId);
  if (!packageSlug) return [];

  const config = await readOpenClawConfig() as Record<string, unknown>;
  const activeEntry = getAgentEntries(config).find((entry) => entry.id === activeAgentId);
  if (!activeEntry) return [];

  const retiredIds = await listRetiredDigitalEmployeeAgentIds();
  const reactivated: string[] = [];

  for (const historicalId of retiredIds) {
    if (historicalId === activeAgentId) continue;
    if (extractDigitalEmployeePackageSlug(historicalId) !== packageSlug) continue;

    const configChanged = await ensureHistoricalAgentProxyEntry(historicalId, activeEntry, displayName);
    const sessionsRestored = await restoreHistoricalAgentSessionsIfNeeded(historicalId);
    if (configChanged || sessionsRestored) {
      reactivated.push(historicalId);
    }
  }

  return reactivated;
}

export async function reactivateHistoricalDigitalEmployeesForAllInstalled(): Promise<{
  reactivatedAgentIds: string[];
}> {
  const employees = await listLocalDigitalEmployees();
  const reactivatedAgentIds: string[] = [];

  for (const employee of employees) {
    if (employee.status !== 'active' && employee.status !== 'degraded') continue;
    const reactivated = await reactivateHistoricalDigitalEmployeeAgentsForActive(
      employee.agentId,
      employee.name,
    );
    reactivatedAgentIds.push(...reactivated);
  }

  return { reactivatedAgentIds: [...new Set(reactivatedAgentIds)] };
}

export async function prepareHistoricalDigitalEmployeeChatSend(
  params: unknown,
  options?: { reloadGateway?: () => Promise<void> },
): Promise<unknown> {
  if (!params || typeof params !== 'object') return params;

  const record = params as Record<string, unknown>;
  const sessionKey = typeof record.sessionKey === 'string' ? record.sessionKey.trim() : '';
  const executeAsAgentId = typeof record.executeAsAgentId === 'string' ? record.executeAsAgentId.trim() : '';
  if (!sessionKey || !executeAsAgentId) return params;

  const sessionAgentId = parseAgentIdFromSessionKey(sessionKey);
  if (!sessionAgentId || sessionAgentId === executeAsAgentId) return params;
  if (!sessionAgentId.startsWith('employee-') || !executeAsAgentId.startsWith('employee-')) return params;

  const sessionSlug = extractDigitalEmployeePackageSlug(sessionAgentId);
  const executeSlug = extractDigitalEmployeePackageSlug(executeAsAgentId);
  if (!sessionSlug || sessionSlug !== executeSlug) return params;

  const config = await readOpenClawConfig() as Record<string, unknown>;
  const entries = getAgentEntries(config);
  const activeEntry = entries.find((entry) => entry.id === executeAsAgentId);
  if (!activeEntry) return params;

  const sessionEntry = entries.find((entry) => entry.id === sessionAgentId);
  let configChanged = false;
  if (!sessionEntry) {
    configChanged = await ensureHistoricalAgentProxyEntry(
      sessionAgentId,
      activeEntry,
      typeof record.executedByAgentName === 'string' && record.executedByAgentName.trim()
        ? record.executedByAgentName.trim()
        : activeEntry.name || executeAsAgentId,
    );
  }

  await restoreHistoricalAgentSessionsIfNeeded(sessionAgentId);

  if (configChanged && options?.reloadGateway) {
    // Avoid blocking chat.send on a full gateway reload; config is picked up on next natural reload.
    void options.reloadGateway().catch((error) => {
      logger.warn('Failed to reload gateway after historical digital employee proxy ensure', {
        sessionAgentId,
        executeAsAgentId,
        error: String(error),
      });
    });
  }

  return record;
}
