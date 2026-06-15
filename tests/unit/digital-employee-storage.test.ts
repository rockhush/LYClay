import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DigitalEmployeeInstallRecord } from '../../shared/types/digital-employee';

const root = join(tmpdir(), `lyclaw-digital-employees-${Math.random().toString(36).slice(2)}`);

beforeEach(async () => {
  process.env.CLAWX_DIGITAL_EMPLOYEES_DIR = root;
  await rm(root, { recursive: true, force: true });
});

afterEach(async () => {
  delete process.env.CLAWX_DIGITAL_EMPLOYEES_DIR;
  await rm(root, { recursive: true, force: true });
});

async function writeEmployee(instanceId: string, status: DigitalEmployeeInstallRecord['status']): Promise<void> {
  const installDir = join(root, instanceId);
  await mkdir(installDir, { recursive: true });
  await writeFile(join(installDir, 'employee.json'), JSON.stringify({
    schemaVersion: 1,
    package: {
      id: 'com.lyclaw.employee.document-analyst',
      name: 'Document Analyst',
      version: '1.0.0',
      description: 'Analyze documents.',
      tags: ['documents'],
    },
    agent: {
      workspaceSource: 'agent/workspace',
    },
  }), 'utf8');
  await writeFile(join(installDir, 'install.json'), JSON.stringify({
    schemaVersion: 1,
    instanceId,
    marketEmployeeId: 'market-1',
    packageId: 'com.lyclaw.employee.document-analyst',
    packageVersion: '1.0.0',
    installPath: installDir,
    agentId: `${instanceId}-agent`,
    agentWorkspace: join(root, 'workspace'),
    packagedSkills: [],
    installedMcpServers: [],
    status,
    installedAt: new Date().toISOString(),
    warnings: [],
  } satisfies DigitalEmployeeInstallRecord), 'utf8');
}

describe('digital employee storage', () => {
  it('lists active and degraded employees but hides preparing installations', async () => {
    await writeEmployee('emp-active', 'active');
    await writeEmployee('emp-degraded', 'degraded');
    await writeEmployee('emp-preparing', 'preparing');

    const { listLocalDigitalEmployees } = await import('@electron/utils/digital-employee-storage');
    const employees = await listLocalDigitalEmployees();

    expect(employees.map((employee) => employee.instanceId).sort())
      .toEqual(['emp-active', 'emp-degraded']);
    expect(employees[0].sessionKey).toMatch(/^agent:.+:main$/);
    expect(employees.every((employee) => employee.enabled)).toBe(true);
  });

  it('persists userEnabled in install.json and exposes it via listLocalDigitalEmployees', async () => {
    await writeEmployee('emp-toggle', 'active');

    const { setDigitalEmployeeEnabled, listLocalDigitalEmployees } = await import('@electron/utils/digital-employee-storage');
    await setDigitalEmployeeEnabled('emp-toggle', false);

    const employees = await listLocalDigitalEmployees();
    const employee = employees.find((entry) => entry.instanceId === 'emp-toggle');
    expect(employee?.enabled).toBe(false);

    await setDigitalEmployeeEnabled('emp-toggle', true);
    const reloaded = await listLocalDigitalEmployees();
    expect(reloaded.find((entry) => entry.instanceId === 'emp-toggle')?.enabled).toBe(true);
  });

  it('rejects invalid instance ids before resolving an installation path', async () => {
    const { getDigitalEmployeeInstallPath } = await import('@electron/utils/digital-employee-storage');

    expect(() => getDigitalEmployeeInstallPath('../escape')).toThrow('Invalid digital employee instanceId');
  });
});
