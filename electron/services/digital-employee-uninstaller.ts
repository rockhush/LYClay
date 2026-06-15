import type {
  DigitalEmployeeInstallRecord,
  UninstallDigitalEmployeeResult,
} from '../../shared/types/digital-employee';
import { deleteAgentConfig, removeAgentWorkspaceDirectory } from '../utils/agent-config';
import {
  getDigitalEmployeeInstallPath,
  listLocalDigitalEmployees,
  readInstallRecord,
  removeDigitalEmployeeDirectory,
} from '../utils/digital-employee-storage';
import { withDigitalEmployeeInstallLock } from './digital-employee-installer';

export interface DigitalEmployeeUninstallerDependencies {
  listInstalled: typeof listLocalDigitalEmployees;
  readRecord: (instanceId: string) => Promise<DigitalEmployeeInstallRecord>;
  deleteAgent: (agentId: string) => Promise<void>;
  removeInstallDirectory: (path: string) => Promise<void>;
}

async function deleteBoundAgent(agentId: string): Promise<void> {
  const { removedEntry } = await deleteAgentConfig(agentId);
  await removeAgentWorkspaceDirectory(removedEntry);
}

const defaultDependencies: DigitalEmployeeUninstallerDependencies = {
  listInstalled: listLocalDigitalEmployees,
  readRecord: async (instanceId) => readInstallRecord(getDigitalEmployeeInstallPath(instanceId)),
  deleteAgent: deleteBoundAgent,
  removeInstallDirectory: removeDigitalEmployeeDirectory,
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
    await dependencies.deleteAgent(record.agentId);
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
