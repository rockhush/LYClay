import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DigitalEmployeeInstallRecord,
  DigitalEmployeePackageManifest,
} from '../../shared/types/digital-employee';
import type { DigitalEmployeeUpdaterDependencies } from '../../electron/services/digital-employee-updater';

const root = join(tmpdir(), `lyclaw-digital-employee-updater-${Math.random().toString(36).slice(2)}`);
const employeesRoot = join(root, 'employees');
const instanceId = 'document-analyst--a1b2c3d4';
const installPath = join(employeesRoot, instanceId);
const workspace = join(root, 'workspace');
const packageRoot = join(root, 'new-package');
const agentId = 'employee-document-analyst-a1b2c3d4';

const oldManifest: DigitalEmployeePackageManifest = {
  schemaVersion: 1,
  package: {
    id: 'com.lyclaw.employee.document-analyst',
    name: 'Document Analyst 1.0',
    version: '1.0.0',
    description: 'Old package',
  },
  agent: { workspaceSource: 'agent/workspace' },
};

const newManifest: DigitalEmployeePackageManifest = {
  ...oldManifest,
  package: {
    ...oldManifest.package,
    name: 'Document Analyst 1.1',
    version: '1.1.0',
    description: 'New package',
  },
};

beforeEach(async () => {
  process.env.CLAWX_DIGITAL_EMPLOYEES_DIR = employeesRoot;
  await rm(root, { recursive: true, force: true });
  await mkdir(join(installPath, 'agent', 'workspace'), { recursive: true });
  await mkdir(join(installPath, 'mcp'), { recursive: true });
  await mkdir(join(installPath, 'resources'), { recursive: true });
  await mkdir(join(packageRoot, 'agent', 'workspace'), { recursive: true });
  await mkdir(join(packageRoot, 'mcp'), { recursive: true });
  await mkdir(join(packageRoot, 'resources'), { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(join(installPath, 'employee.json'), JSON.stringify(oldManifest), 'utf8');
  await writeFile(join(installPath, 'old-package-file.txt'), 'old package', 'utf8');
  await writeFile(join(installPath, 'resources', 'api-contracts.md'), '# Old API', 'utf8');
  await writeFile(join(packageRoot, 'employee.json'), JSON.stringify(newManifest), 'utf8');
  await writeFile(join(packageRoot, 'new-package-file.txt'), 'new package', 'utf8');
  await writeFile(join(packageRoot, 'resources', 'api-contracts.md'), '# New API', 'utf8');
  await writeFile(
    join(installPath, 'mcp', 'servers.template.json'),
    JSON.stringify({ servers: { docs: { url: 'https://old.example.com/docs' } } }),
    'utf8',
  );
  await writeFile(
    join(packageRoot, 'mcp', 'servers.template.json'),
    JSON.stringify({ servers: { docs: { url: 'https://new.example.com/docs' } } }),
    'utf8',
  );
  await writeFile(join(packageRoot, 'agent', 'workspace', 'AGENTS.md'), '# New role', 'utf8');
  await writeFile(join(packageRoot, 'agent', 'workspace', 'SOUL.md'), '# New soul', 'utf8');
  await writeFile(join(workspace, 'AGENTS.md'), '# Old role', 'utf8');
  await writeFile(join(workspace, 'TOOLS.md'), '# Old tools', 'utf8');
  await writeFile(join(workspace, 'USER.md'), '# User data', 'utf8');
  await mkdir(join(workspace, 'resources'), { recursive: true });
  await writeFile(join(workspace, 'resources', 'api-contracts.md'), '# Workspace old API', 'utf8');
  const record: DigitalEmployeeInstallRecord = {
    schemaVersion: 1,
    instanceId,
    marketEmployeeId: 'market-1',
    packageId: oldManifest.package.id,
    packageVersion: oldManifest.package.version,
    installPath,
    agentId,
    agentWorkspace: workspace,
    packagedSkills: [],
    installedMcpServers: [],
    status: 'active',
    installedAt: new Date().toISOString(),
    warnings: [],
  };
  await writeFile(join(installPath, 'install.json'), JSON.stringify(record), 'utf8');
});

afterEach(async () => {
  delete process.env.CLAWX_DIGITAL_EMPLOYEES_DIR;
  await rm(root, { recursive: true, force: true });
});

function createDependencies(
  overrides: Partial<DigitalEmployeeUpdaterDependencies> = {},
): DigitalEmployeeUpdaterDependencies {
  return {
    downloadPackage: async (_input, target) => writeFile(target, 'zip', 'utf8'),
    validateZip: () => undefined,
    extractPackage: async () => undefined,
    validatePackage: async () => ({
      rootDir: packageRoot,
      manifest: newManifest,
      agentTemplate: {
        name: 'Updated Employee',
        model: 'provider/new-model',
      },
      mcpConfig: null,
      skillDirectories: [],
      warnings: [],
    }),
    getAgent: async () => ({
      id: agentId,
      name: 'Old Employee',
      isDefault: false,
      modelDisplay: 'old-model',
      modelRef: 'provider/old-model',
      overrideModelRef: 'provider/old-model',
      inheritedModel: false,
      workspace,
      agentDir: join(root, 'agents', agentId, 'agent'),
      mainSessionKey: `agent:${agentId}:main`,
      channelTypes: [],
    }),
    updateAgent: async () => undefined,
    ...overrides,
  };
}

describe('digital employee updater', () => {
  it('replaces managed content while preserving USER.md and instance identity', async () => {
    const updateAgent = vi.fn(async () => undefined);
    const { updateDigitalEmployee } = await import('@electron/services/digital-employee-updater');

    const result = await updateDigitalEmployee(
      instanceId,
      {},
      createDependencies({ updateAgent }),
    );

    expect(result).toMatchObject({
      instanceId,
      agentId,
      fromVersion: '1.0.0',
      toVersion: '1.1.0',
    });
    expect(await readFile(join(workspace, 'AGENTS.md'), 'utf8')).toBe('# New role');
    expect(await readFile(join(workspace, 'SOUL.md'), 'utf8')).toBe('# New soul');
    await expect(access(join(workspace, 'TOOLS.md'))).rejects.toThrow();
    expect(await readFile(join(workspace, 'USER.md'), 'utf8')).toBe('# User data');
    await expect(access(join(installPath, 'old-package-file.txt'))).rejects.toThrow();
    expect(await readFile(join(installPath, 'new-package-file.txt'), 'utf8')).toBe('new package');
    expect(await readFile(join(workspace, 'resources', 'api-contracts.md'), 'utf8')).toBe('# New API');
    expect(
      JSON.parse(await readFile(join(installPath, 'mcp', 'servers.template.json'), 'utf8')),
    ).toEqual({
      servers: {
        docs: {
          url: 'https://new.example.com/docs',
        },
      },
    });
    expect(updateAgent).toHaveBeenCalledWith(agentId, {
      name: 'Updated Employee',
      modelRef: 'provider/new-model',
    });
    const record = JSON.parse(await readFile(join(installPath, 'install.json'), 'utf8')) as {
      packageVersion: string;
      updateHistory: Array<{ fromVersion: string; toVersion: string }>;
    };
    expect(record.packageVersion).toBe('1.1.0');
    expect(record.updateHistory).toContainEqual(expect.objectContaining({
      fromVersion: '1.0.0',
      toVersion: '1.1.0',
    }));
  });

  it('rejects mismatched or non-newer packages before replacing content', async () => {
    const { updateDigitalEmployee } = await import('@electron/services/digital-employee-updater');
    const mismatched = {
      ...newManifest,
      package: { ...newManifest.package, id: 'com.example.other' },
    };

    await expect(updateDigitalEmployee(instanceId, {}, createDependencies({
      validatePackage: async () => ({
        rootDir: packageRoot,
        manifest: mismatched,
        agentTemplate: null,
        mcpConfig: null,
        skillDirectories: [],
        warnings: [],
      }),
    }))).rejects.toThrow('packageId does not match');

    await expect(updateDigitalEmployee(instanceId, {}, createDependencies({
      validatePackage: async () => ({
        rootDir: packageRoot,
        manifest: oldManifest,
        agentTemplate: null,
        mcpConfig: null,
        skillDirectories: [],
        warnings: [],
      }),
    }))).rejects.toThrow('must be newer');
    expect(await readFile(join(installPath, 'old-package-file.txt'), 'utf8')).toBe('old package');
    expect(
      JSON.parse(await readFile(join(installPath, 'mcp', 'servers.template.json'), 'utf8')),
    ).toEqual({
      servers: {
        docs: {
          url: 'https://old.example.com/docs',
        },
      },
    });
  });

  it('restores package and workspace when the Agent update fails', async () => {
    const updates: Array<{ name: string; modelRef: string | null }> = [];
    const { updateDigitalEmployee } = await import('@electron/services/digital-employee-updater');

    await expect(updateDigitalEmployee(instanceId, {}, createDependencies({
      updateAgent: async (_id, update) => {
        updates.push(update);
        if (update.name === 'Updated Employee') {
          throw new Error('Agent update failed');
        }
      },
    }))).rejects.toThrow('Agent update failed');

    expect(await readFile(join(installPath, 'old-package-file.txt'), 'utf8')).toBe('old package');
    expect(await readFile(join(workspace, 'AGENTS.md'), 'utf8')).toBe('# Old role');
    expect(await readFile(join(workspace, 'TOOLS.md'), 'utf8')).toBe('# Old tools');
    await expect(access(join(workspace, 'SOUL.md'))).rejects.toThrow();
    expect(await readFile(join(workspace, 'USER.md'), 'utf8')).toBe('# User data');
    expect(await readFile(join(workspace, 'resources', 'api-contracts.md'), 'utf8')).toBe('# Workspace old API');
    expect(updates).toEqual([
      { name: 'Updated Employee', modelRef: 'provider/new-model' },
      { name: 'Old Employee', modelRef: 'provider/old-model' },
    ]);
  });
});
