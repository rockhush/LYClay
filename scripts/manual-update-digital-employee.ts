import { copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  updateDigitalEmployee,
  type DigitalEmployeeUpdaterDependencies,
} from '../electron/services/digital-employee-updater';
import {
  listAgentsSnapshot,
  updateAgentDefinition,
} from '../electron/utils/agent-config';
import {
  validateDigitalEmployeeZip,
  validateExtractedDigitalEmployeePackage,
} from '../electron/utils/digital-employee-package';
import {
  getDigitalEmployeeInstallPath,
  listLocalDigitalEmployees,
  readInstallRecord,
} from '../electron/utils/digital-employee-storage';
import { extractZipToDir } from '../electron/utils/local-skill-upload';

const DEFAULT_PACKAGE = 'artifacts/digital-employee-package-example2/document-analyst-1.0.1.zip';

async function resolveInstanceId(explicitInstanceId?: string): Promise<string> {
  if (explicitInstanceId?.trim()) return explicitInstanceId.trim();
  const employees = await listLocalDigitalEmployees();
  if (employees.length === 1) return employees[0].instanceId;
  if (employees.length === 0) {
    throw new Error('No installed digital employee was found. Install one before updating.');
  }
  throw new Error(
    `Multiple digital employees are installed; pass one instanceId explicitly: ${
      employees.map((employee) => employee.instanceId).join(', ')
    }`,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const positional = args.filter((arg) => !arg.startsWith('--'));
  const instanceIdArg = positional[0];
  const packageArg = positional[1] ?? DEFAULT_PACKAGE;
  const packagePath = resolve(packageArg);

  if (!apply) {
    console.log([
      'Manual digital employee update test',
      '',
      'Usage:',
      'pnpm run employee:update:manual -- --apply <instanceId> <package.zip>',
      '',
      `Default package: ${packagePath}`,
      '',
      'This test will modify your real local OpenClaw configuration:',
      '- update the installed employee package in place',
      '- update managed Agent workspace files except USER.md',
      '- update the Agent name/model and packaged employee content',
      '',
      'Run with --apply to continue.',
    ].join('\n'));
    return;
  }

  const instanceId = await resolveInstanceId(instanceIdArg);
  console.log(`Updating local employee instance: ${instanceId}`);
  console.log(`Using local package: ${packagePath}`);

  const dependencies: DigitalEmployeeUpdaterDependencies = {
    downloadPackage: async (_input, targetZipPath) => {
      await copyFile(packagePath, targetZipPath);
    },
    validateZip: validateDigitalEmployeeZip,
    extractPackage: extractZipToDir,
    validatePackage: validateExtractedDigitalEmployeePackage,
    getAgent: async (agentId) => {
      const agent = (await listAgentsSnapshot()).agents.find((entry) => entry.id === agentId);
      if (!agent) throw new Error(`Bound Agent "${agentId}" not found`);
      return agent;
    },
    updateAgent: async (agentId, updates) => {
      await updateAgentDefinition(agentId, updates);
    },
  };

  const result = await updateDigitalEmployee(instanceId, {}, dependencies);
  const installPath = getDigitalEmployeeInstallPath(result.instanceId);
  const record = await readInstallRecord(installPath);

  console.log(JSON.stringify({
    success: true,
    ...result,
    installPath,
    agentWorkspace: record.agentWorkspace,
    installedMcpServers: record.installedMcpServers,
    updateHistory: record.updateHistory ?? [],
  }, null, 2));
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
