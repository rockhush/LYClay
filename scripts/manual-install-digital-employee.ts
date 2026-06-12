import { copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  createDigitalEmployeeInstallerDependencies,
  installDigitalEmployee,
} from '../electron/services/digital-employee-installer';
import {
  getDigitalEmployeeInstallPath,
  readInstallRecord,
} from '../electron/utils/digital-employee-storage';

const DEFAULT_PACKAGE = 'artifacts/digital-employee-package-example2/document-analyst-1.0.0.zip';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const marketIdIndex = args.indexOf('--market-id');
  const marketEmployeeId = marketIdIndex >= 0 ? args[marketIdIndex + 1]?.trim() : undefined;
  const packageArg = args.find((arg, index) => (
    !arg.startsWith('--') && index !== marketIdIndex + 1
  )) ?? DEFAULT_PACKAGE;
  const packagePath = resolve(packageArg);

  if (!apply) {
    console.log([
      'Manual digital employee installation test',
      '',
      marketEmployeeId
        ? `Marketplace employee id: ${marketEmployeeId}`
        : `Local package: ${packagePath}`,
      '',
      'This test will modify your real local OpenClaw configuration:',
      '- create an exclusive Agent and Agent workspace',
      '- install the employee under ~/.openclaw/digital-employees',
      '- preserve packaged Skills and MCP configuration inside the employee directory',
      '',
      'Test the real marketplace download endpoint:',
      'pnpm run employee:install:manual -- --apply --market-id 7',
      '',
      'Or install a local ZIP:',
      `pnpm run employee:install:manual -- --apply "${packageArg}"`,
    ].join('\n'));
    return;
  }

  if (marketIdIndex >= 0 && !marketEmployeeId) {
    throw new Error('--market-id requires a positive marketplace employee id');
  }

  const dependencies = marketEmployeeId
    ? undefined
    : createDigitalEmployeeInstallerDependencies({
      downloadPackage: async (_input, targetZipPath) => {
        await copyFile(packagePath, targetZipPath);
      },
    });

  console.log(
    marketEmployeeId
      ? `Downloading and installing marketplace employee: ${marketEmployeeId}`
      : `Installing local package: ${packagePath}`,
  );

  const result = await installDigitalEmployee(
    { marketEmployeeId: marketEmployeeId ?? '7' },
    dependencies,
  );
  const installPath = getDigitalEmployeeInstallPath(result.instanceId);
  const record = await readInstallRecord(installPath);

  console.log(JSON.stringify({
    success: true,
    ...result,
    installPath,
    agentWorkspace: record.agentWorkspace,
    installedMcpServers: record.installedMcpServers,
  }, null, 2));
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
