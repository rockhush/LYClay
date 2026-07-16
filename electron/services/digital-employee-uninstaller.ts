import type {
  DigitalEmployeeInstallRecord,
  UninstallDigitalEmployeeResult,
} from '../../shared/types/digital-employee';
import { deleteAgentConfig, removeAgentWorkspaceDirectory } from '../utils/agent-config';
import { archiveAgentSessionsBeforeRemoval } from '../utils/retired-agent-sessions';
import { removeEmployeeMcpServers } from '../utils/digital-employee-mcp';
import {
  getDigitalEmployeeInstallPath,
  listLocalDigitalEmployees,
  readInstallRecord,
  removeDigitalEmployeeDirectory,
} from '../utils/digital-employee-storage';
import { withDigitalEmployeeInstallLock } from './digital-employee-installer';
import { cleanupDigitalEmployeeSub2ApiModels } from './sub2api/model-sync-service';
import * as logger from '../utils/logger';

export interface DigitalEmployeeUninstallerDependencies {
  listInstalled: typeof listLocalDigitalEmployees;
  readRecord: (instanceId: string) => Promise<DigitalEmployeeInstallRecord>;
  deleteAgent: (agentId: string) => Promise<void>;
  archiveAgentSessions: (agentId: string) => Promise<boolean>;
  cleanupSub2ApiModels: typeof cleanupDigitalEmployeeSub2ApiModels;
  removeInstallDirectory: (path: string) => Promise<void>;
  removeMcpServers: (runtimeNames: string[]) => Promise<void>;
}

function isAgentNotFoundError(error: unknown, agentId: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().toLowerCase() === `agent "${agentId}" not found`.toLowerCase();
}

async function deleteBoundAgent(agentId: string): Promise<void> {
  try {
    const { removedEntry } = await deleteAgentConfig(agentId);
    await removeAgentWorkspaceDirectory(removedEntry);
  } catch (error) {
    if (!isAgentNotFoundError(error, agentId)) {
      throw error;
    }
    await removeAgentWorkspaceDirectory({
      id: agentId,
      workspace: `~/.openclaw/workspace-${agentId}`,
    });
  }
}

const defaultDependencies: DigitalEmployeeUninstallerDependencies = {
  listInstalled: listLocalDigitalEmployees,
  readRecord: async (instanceId) => readInstallRecord(getDigitalEmployeeInstallPath(instanceId)),
  deleteAgent: deleteBoundAgent,
  archiveAgentSessions: archiveAgentSessionsBeforeRemoval,
  cleanupSub2ApiModels: cleanupDigitalEmployeeSub2ApiModels,
  removeInstallDirectory: removeDigitalEmployeeDirectory,
  removeMcpServers: removeEmployeeMcpServers,
};

export function createDigitalEmployeeUninstallerDependencies(
  overrides: Partial<DigitalEmployeeUninstallerDependencies> = {},
): DigitalEmployeeUninstallerDependencies {
  return { ...defaultDependencies, ...overrides };
}

export async function uninstallDigitalEmployee(
  instanceId: string,
  dependencies: DigitalEmployeeUninstallerDependencies = defaultDependencies,
): Promise<UninstallDigitalEmployeeResult> {
  const normalizedInstanceId = instanceId.trim();
  if (!normalizedInstanceId) {
    throw new Error('instanceId is required');
  }

  return withDigitalEmployeeInstallLock(async () => {
    const record = await dependencies.readRecord(normalizedInstanceId);
    await dependencies.cleanupSub2ApiModels(record.instanceId);
    try {
      await dependencies.archiveAgentSessions(record.agentId);
    } catch (error) {
      logger.warn('Failed to archive digital employee sessions before uninstall; continuing', {
        agentId: record.agentId,
        error: String(error),
      });
    }
    try {
      await dependencies.deleteAgent(record.agentId);
    } catch (error) {
      if (!isAgentNotFoundError(error, record.agentId)) {
        throw error;
      }
    }
    await dependencies.removeMcpServers((record.installedMcpServers ?? []).map((server) => server.runtimeName));
    await dependencies.removeInstallDirectory(record.installPath);
    return {
      instanceId: record.instanceId,
      agentId: record.agentId,
      marketEmployeeId: record.marketEmployeeId,
    };
  });
}

export async function uninstallDigitalEmployeeByMarketId(
  marketEmployeeId: string | number,
  dependencies: DigitalEmployeeUninstallerDependencies = defaultDependencies,
): Promise<UninstallDigitalEmployeeResult> {
  const normalizedMarketEmployeeId = String(marketEmployeeId).trim();
  if (!normalizedMarketEmployeeId) {
    throw new Error('marketEmployeeId is required');
  }

  const installed = await dependencies.listInstalled();
  const target = installed.find(
    (employee) => employee.marketEmployeeId === normalizedMarketEmployeeId,
  );
  if (!target) {
    throw new Error(`Digital employee "${normalizedMarketEmployeeId}" is not installed`);
  }

  return uninstallDigitalEmployee(target.instanceId, dependencies);
}
