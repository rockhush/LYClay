import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DigitalEmployeePackageManifest } from '../../shared/types/digital-employee';
import type { DigitalEmployeeInstallerDependencies } from '../../electron/services/digital-employee-installer';

const root = join(tmpdir(), `lyclaw-digital-employee-installer-${Math.random().toString(36).slice(2)}`);
const employeesRoot = join(root, 'employees');
const packageRoot = join(root, 'package');
const agentWorkspace = join(root, 'workspace-agent');

const manifest: DigitalEmployeePackageManifest = {
  schemaVersion: 1,
  package: {
    id: 'com.lyclaw.employee.document-analyst',
    name: 'Document Analyst',
    version: '1.0.0',
    description: 'Analyze documents.',
  },
  agent: {
    workspaceSource: 'agent/workspace',
  },
};

beforeEach(async () => {
  process.env.CLAWX_DIGITAL_EMPLOYEES_DIR = employeesRoot;
  await rm(root, { recursive: true, force: true });
  await mkdir(join(packageRoot, 'agent', 'workspace'), { recursive: true });
  await mkdir(join(packageRoot, 'mcp'), { recursive: true });
  await mkdir(join(packageRoot, 'resources'), { recursive: true });
  await writeFile(join(packageRoot, 'employee.json'), JSON.stringify(manifest), 'utf8');
  await writeFile(join(packageRoot, 'agent', 'workspace', 'AGENTS.md'), '# Installed role\n', 'utf8');
  await writeFile(join(packageRoot, 'agent', 'workspace', 'USER.md'), '# Packaged user\n', 'utf8');
  await writeFile(join(packageRoot, 'resources', 'api-contracts.md'), '# API contracts\n', 'utf8');
  await writeFile(
    join(packageRoot, 'mcp', 'servers.template.json'),
    JSON.stringify({ servers: { docs: { url: 'https://mcp.example.com/docs' } } }),
    'utf8',
  );
});

afterEach(async () => {
  delete process.env.CLAWX_DIGITAL_EMPLOYEES_DIR;
  await rm(root, { recursive: true, force: true });
});

function createDependencies(overrides: Partial<DigitalEmployeeInstallerDependencies> = {}) {
  const deleteAgent = vi.fn(async () => undefined);
  const dependencies: DigitalEmployeeInstallerDependencies = {
    downloadPackage: async (_input, target) => writeFile(target, 'test zip', 'utf8'),
    validateZip: () => undefined,
    extractPackage: async () => undefined,
    validatePackage: async () => ({
      rootDir: packageRoot,
      manifest,
      agentTemplate: null,
      mcpConfig: null,
      skillDirectories: [],
      warnings: [],
    }),
    findInstalledByPackageId: async () => null,
    createAgent: async (name, options) => ({
      createdAgent: {
        id: options.preferredId,
        name,
        isDefault: false,
        modelDisplay: 'test',
        modelRef: null,
        overrideModelRef: null,
        inheritedModel: true,
        workspace: agentWorkspace,
        agentDir: join(root, 'agents', options.preferredId, 'agent'),
        mainSessionKey: `agent:${options.preferredId}:main`,
        channelTypes: [],
      },
    }),
    deleteAgent,
    ensureContext: async () => undefined,
    syncSub2ApiModels: async () => ({ status: 'skipped-missing-subject' }),
    updateAgentModel: async () => ({ agents: [], defaultAgentId: 'main', defaultModelRef: null, configuredChannelTypes: [], channelOwners: {}, channelAccountOwners: {} }),
    syncAgentRuntimeModel: async () => undefined,
    ...overrides,
  };
  return { dependencies, deleteAgent };
}

describe('digital employee installer', () => {
  it('builds the package download URL from a positive marketplace id', async () => {
    const {
      buildDigitalEmployeeDownloadUrl,
      isTrustedDigitalEmployeeDownloadHost,
      MAX_DIGITAL_EMPLOYEE_DOWNLOAD_BYTES,
    } = await import(
      '@electron/services/digital-employee-installer'
    );

    expect(MAX_DIGITAL_EMPLOYEE_DOWNLOAD_BYTES).toBe(512 * 1024 * 1024);
    expect(buildDigitalEmployeeDownloadUrl('7').href).toBe(
      'https://ai.lingyiitech.com/management/agents/download/7/',
    );
    expect(buildDigitalEmployeeDownloadUrl(7).href).toBe(
      'https://ai.lingyiitech.com/management/agents/download/7/',
    );
    expect(isTrustedDigitalEmployeeDownloadHost('ai.lingyiitech.com')).toBe(true);
    expect(isTrustedDigitalEmployeeDownloadHost('AI.LINGYIITECH.COM')).toBe(true);
    expect(isTrustedDigitalEmployeeDownloadHost('evil.ai.lingyiitech.com')).toBe(false);
    for (const invalidId of ['', '0', '-1', 'abc', '7/../../test', 'https://example.com']) {
      expect(() => buildDigitalEmployeeDownloadUrl(invalidId)).toThrow(
        'marketEmployeeId must be a positive integer',
      );
    }
  });

  it('creates a local employee directory and binds the generated Agent', async () => {
    const createAgent = vi.fn(createDependencies().dependencies.createAgent);
    const { dependencies } = createDependencies({ createAgent });
    const {
      createDigitalEmployeeInstallIdentity,
      installDigitalEmployee,
    } = await import('@electron/services/digital-employee-installer');

    const result = await installDigitalEmployee({
      marketEmployeeId: '7',
    }, dependencies);

    expect(result.agentId).toMatch(/^employee-document-analyst-[a-f0-9]{8}$/);
    expect(result.instanceId).toMatch(/^document-analyst-[a-f0-9]{8}$/);
    expect(result.status).toBe('active');
    expect(createAgent).toHaveBeenCalledWith('Document Analyst', {
      preferredId: expect.stringMatching(/^employee-document-analyst-[a-f0-9]{8}$/),
      modelRef: null,
      inheritWorkspace: true,
    });
    expect(createDigitalEmployeeInstallIdentity(
      'com.lyclaw.employee.document-analyst',
      'A1B2C3D4',
    )).toEqual({
      instanceId: 'document-analyst-a1b2c3d4',
      agentId: 'employee-document-analyst-a1b2c3d4',
    });
    expect(await readFile(join(agentWorkspace, 'AGENTS.md'), 'utf8')).toContain('Installed role');
    expect(await readFile(join(agentWorkspace, 'resources', 'api-contracts.md'), 'utf8')).toBe('# API contracts\n');
    expect(
      JSON.parse(
        await readFile(
          join(employeesRoot, result.instanceId, 'mcp', 'servers.template.json'),
          'utf8',
        ),
      ),
    ).toEqual({
      servers: {
        docs: {
          url: 'https://mcp.example.com/docs',
        },
      },
    });
    const installRecord = JSON.parse(
      await readFile(join(employeesRoot, result.instanceId, 'install.json'), 'utf8'),
    ) as { agentId: string; marketEmployeeId: string; status: string };
    expect(installRecord).toMatchObject({
      agentId: result.agentId,
      marketEmployeeId: '7',
      status: 'active',
    });
  });


  it('syncs employee-scoped Sub2API models after publishing and applies the scoped default model', async () => {
    const syncSub2ApiModels = vi.fn(async () => ({
      status: 'success' as const,
      subjectHash: 'employeehash',
      modelCount: 1,
      defaultModel: 'custom-sub2ed291be5b/recruiting-model',
    }));
    const updateAgentModelMock = vi.fn(async () => ({
      agents: [],
      defaultAgentId: 'main',
      defaultModelRef: null,
      configuredChannelTypes: [],
      channelOwners: {},
      channelAccountOwners: {},
    }));
    const syncAgentRuntimeModel = vi.fn(async () => undefined);
    const { dependencies } = createDependencies({
      syncSub2ApiModels,
      updateAgentModel: updateAgentModelMock,
      syncAgentRuntimeModel,
    });
    const { installDigitalEmployee } = await import('@electron/services/digital-employee-installer');

    const result = await installDigitalEmployee({ marketEmployeeId: '7' }, dependencies);

    expect(syncSub2ApiModels).toHaveBeenCalledWith(expect.objectContaining({
      marketEmployeeId: '7',
      instanceId: result.instanceId,
      agentId: result.agentId,
      manifest,
    }), 'install');
    expect(updateAgentModelMock).toHaveBeenCalledWith(result.agentId, 'custom-sub2ed291be5b/recruiting-model');
    expect(syncAgentRuntimeModel).toHaveBeenCalledWith(result.agentId);
  });
  it('preserves USER.md inherited from the main Agent during installation', async () => {
    await mkdir(agentWorkspace, { recursive: true });
    await writeFile(join(agentWorkspace, 'USER.md'), '# Main user profile\n', 'utf8');
    const { dependencies } = createDependencies();
    const { installDigitalEmployee } = await import('@electron/services/digital-employee-installer');

    await installDigitalEmployee({
      marketEmployeeId: '7',
    }, dependencies);

    expect(await readFile(join(agentWorkspace, 'USER.md'), 'utf8')).toBe('# Main user profile\n');
  });

  it('uses the validated Agent template name and model', async () => {
    const createAgent = vi.fn(createDependencies().dependencies.createAgent);
    const { dependencies } = createDependencies({
      createAgent,
      validatePackage: async () => ({
        rootDir: packageRoot,
        manifest,
        agentTemplate: {
          id: '${AGENT_ID}',
          name: 'Template Employee',
          workspace: '~/.openclaw/workspace-${AGENT_ID}',
          agentDir: '~/.openclaw/agents/${AGENT_ID}/agent',
          model: 'provider/template-model',
        },
        mcpConfig: null,
        skillDirectories: [],
        warnings: [],
      }),
    });
    const { installDigitalEmployee } = await import('@electron/services/digital-employee-installer');

    await installDigitalEmployee({
      marketEmployeeId: '7',
    }, dependencies);

    expect(createAgent).toHaveBeenCalledWith('Template Employee', {
      preferredId: expect.stringMatching(/^employee-document-analyst-[a-f0-9]{8}$/),
      modelRef: 'provider/template-model',
      inheritWorkspace: true,
    });
  });

  it('rejects a second installation when the package disallows multiple instances', async () => {
    const singleInstanceManifest: DigitalEmployeePackageManifest = {
      ...manifest,
      install: {
        allowMultipleInstances: false,
      },
    };
    const createAgent = vi.fn(createDependencies().dependencies.createAgent);
    const { dependencies } = createDependencies({
      createAgent,
      validatePackage: async () => ({
        rootDir: packageRoot,
        manifest: singleInstanceManifest,
        agentTemplate: null,
        mcpConfig: null,
        skillDirectories: [],
        warnings: [],
      }),
      findInstalledByPackageId: async () => ({
        schemaVersion: 1,
        instanceId: 'document-analyst--existing',
        marketEmployeeId: 'market-existing',
        packageId: manifest.package.id,
        packageVersion: manifest.package.version,
        installPath: join(employeesRoot, 'document-analyst--existing'),
        agentId: 'employee-document-analyst-existing',
        agentWorkspace,
        packagedSkills: [],
        installedMcpServers: [],
        status: 'active',
        installedAt: new Date().toISOString(),
        warnings: [],
      }),
    });
    const { installDigitalEmployee } = await import('@electron/services/digital-employee-installer');

    await expect(installDigitalEmployee({
      marketEmployeeId: '7',
    }, dependencies)).rejects.toThrow(
      'already installed as instance "document-analyst--existing"',
    );

    expect(createAgent).not.toHaveBeenCalled();
  });

  it('serializes concurrent single-instance installs so only one succeeds', async () => {
    const singleInstanceManifest: DigitalEmployeePackageManifest = {
      ...manifest,
      install: {
        allowMultipleInstances: false,
      },
    };
    let installed = false;
    const { dependencies } = createDependencies({
      validatePackage: async () => ({
        rootDir: packageRoot,
        manifest: singleInstanceManifest,
        agentTemplate: null,
        mcpConfig: null,
        skillDirectories: [],
        warnings: [],
      }),
      findInstalledByPackageId: async () => installed
        ? {
          schemaVersion: 1,
          instanceId: 'document-analyst--first',
          marketEmployeeId: '7',
          packageId: manifest.package.id,
          packageVersion: manifest.package.version,
          installPath: join(employeesRoot, 'document-analyst--first'),
          agentId: 'employee-document-analyst-first',
          agentWorkspace,
          packagedSkills: [],
          installedMcpServers: [],
          status: 'active',
          installedAt: new Date().toISOString(),
          warnings: [],
        }
        : null,
      ensureContext: async () => {
        installed = true;
      },
    });
    const { installDigitalEmployee } = await import('@electron/services/digital-employee-installer');

    const results = await Promise.allSettled([
      installDigitalEmployee({
        marketEmployeeId: '7',
      }, dependencies),
      installDigitalEmployee({
        marketEmployeeId: '7',
      }, dependencies),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('rolls back the Agent when workspace context setup fails', async () => {
    const { dependencies, deleteAgent } = createDependencies({
      ensureContext: async () => {
        throw new Error('context failed');
      },
    });
    const { installDigitalEmployee } = await import('@electron/services/digital-employee-installer');

    await expect(installDigitalEmployee({
      marketEmployeeId: '7',
    }, dependencies)).rejects.toThrow('context failed');

    expect(deleteAgent).toHaveBeenCalledWith(
      expect.stringMatching(/^employee-document-analyst-[a-f0-9]{8}$/),
    );
  });

  it('deletes the Agent when publishing the employee package fails', async () => {
    const events: string[] = [];
    const { dependencies } = createDependencies({
      deleteAgent: async () => {
        events.push('agent');
      },
    });
    const originalRename = dependencies.validatePackage;
    dependencies.validatePackage = async (extractDir) => {
      const value = await originalRename(extractDir);
      // Force publish failure by pointing the employee root at an existing file.
      await mkdir(employeesRoot, { recursive: true });
      await writeFile(join(employeesRoot, 'block'), 'x', 'utf8');
      process.env.CLAWX_DIGITAL_EMPLOYEES_DIR = join(employeesRoot, 'block');
      return value;
    };
    const { installDigitalEmployee } = await import('@electron/services/digital-employee-installer');

    await expect(installDigitalEmployee({
      marketEmployeeId: '7',
    }, dependencies)).rejects.toThrow();

    expect(events).toEqual(['agent']);
  });
});
