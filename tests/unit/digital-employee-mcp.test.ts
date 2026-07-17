import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DigitalEmployeePackageManifest } from '../../shared/types/digital-employee';

const readMcpConfigMock = vi.fn();
const writeMcpConfigAtomicMock = vi.fn();

vi.mock('@electron/utils/mcp-json', () => ({
  getMcpConfigPath: () => 'openclaw.json#mcp.servers',
  readMcpConfig: (...args: unknown[]) => readMcpConfigMock(...args),
  writeMcpConfigAtomic: (...args: unknown[]) => writeMcpConfigAtomicMock(...args),
}));

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
  mcp: {
    serverTemplate: 'mcp/servers.json',
    bindings: [{
      server: 'company docs',
      required: false,
      enabled: true,
      allowedTools: ['search_documents'],
    }],
  },
};

describe('digital employee MCP installation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    readMcpConfigMock.mockResolvedValue({
      servers: {
        existing: { type: 'streamable-http', url: 'https://existing.example/mcp' },
      },
    });
    writeMcpConfigAtomicMock.mockResolvedValue(undefined);
  });

  it('namespaces packaged MCP servers and registers them as hidden employee tools', async () => {
    const { installEmployeeMcpServers } = await import('@electron/utils/digital-employee-mcp');

    const result = await installEmployeeMcpServers({
      instanceId: 'emp_123',
      agentId: 'employee-emp-123',
      manifest,
      installPath: 'C:/employees/emp_123',
      packageConfig: {
        servers: {
          'company docs': {
            type: 'streamable-http',
            url: 'https://mcp.example.invalid/docs',
            headers: { Authorization: 'Bearer ${COMPANY_DOCS_TOKEN}' },
            tools: { allow: ['unwanted_tool'] },
          },
        },
      },
    });

    expect(result.installedServers).toEqual([{
      sourceName: 'company docs',
      runtimeName: 'emp_123--company-docs',
    }]);
    expect(writeMcpConfigAtomicMock).toHaveBeenCalledWith(
      'openclaw.json#mcp.servers',
      {
        servers: {
          existing: { type: 'streamable-http', url: 'https://existing.example/mcp' },
          'emp_123--company-docs': expect.objectContaining({
            disabled: false,
            toolFilter: { include: ['search_documents'] },
            'x-lyclaw-hidden-from-connectors': true,
            'x-lyclaw-auto-enabled': true,
            'x-lyclaw-owner': {
              type: 'digitalEmployee',
              instanceId: 'emp_123',
              agentId: 'employee-emp-123',
              packageId: 'com.lyclaw.employee.document-analyst',
              sourceName: 'company docs',
            },
          }),
        },
      },
    );
  });

  it('ignores unrelated invalid local MCP servers when installing employee MCP entries', async () => {
    readMcpConfigMock.mockResolvedValue({
      servers: {
        'lyclaw-skill-marketplace': { type: 'stdio', command: 'bad-launcher', args: ['server.js'] },
      },
    });
    const { installEmployeeMcpServers } = await import('@electron/utils/digital-employee-mcp');

    await installEmployeeMcpServers({
      instanceId: 'emp_123',
      agentId: 'employee-emp-123',
      manifest,
      installPath: 'C:/employees/emp_123',
      packageConfig: {
        servers: {
          'company docs': {
            type: 'streamable-http',
            url: 'https://mcp.example.invalid/docs',
          },
        },
      },
    });

    expect(writeMcpConfigAtomicMock).toHaveBeenCalledWith(
      'openclaw.json#mcp.servers',
      {
        servers: expect.objectContaining({
          'lyclaw-skill-marketplace': { type: 'stdio', command: 'bad-launcher', args: ['server.js'] },
          'emp_123--company-docs': expect.objectContaining({
            url: 'https://mcp.example.invalid/docs',
            'x-lyclaw-hidden-from-connectors': true,
          }),
        }),
      },
    );
  });
  it('rejects real credentials embedded in a marketplace package', async () => {
    const { installEmployeeMcpServers } = await import('@electron/utils/digital-employee-mcp');

    await expect(installEmployeeMcpServers({
      instanceId: 'emp_123',
      agentId: 'employee-emp-123',
      manifest,
      installPath: 'C:/employees/emp_123',
      packageConfig: {
        servers: {
          'company docs': {
            type: 'streamable-http',
            url: 'https://mcp.example.invalid/docs',
            headers: { Authorization: 'Bearer real-secret-token' },
          },
        },
      },
    })).rejects.toThrow('contains a packaged header value');

    expect(writeMcpConfigAtomicMock).not.toHaveBeenCalled();
  });

  it('removes only MCP names recorded for the employee instance', async () => {
    readMcpConfigMock.mockResolvedValue({
      servers: {
        existing: { type: 'streamable-http', url: 'https://existing.example/mcp' },
        'emp_123--docs': { disabled: true },
      },
    });
    const { removeEmployeeMcpServers } = await import('@electron/utils/digital-employee-mcp');

    await removeEmployeeMcpServers(['emp_123--docs']);

    expect(writeMcpConfigAtomicMock).toHaveBeenCalledWith(
      'openclaw.json#mcp.servers',
      { servers: { existing: { type: 'streamable-http', url: 'https://existing.example/mcp' } } },
    );
  });

  it('updates templates while preserving locally changed authorization fields', async () => {
    readMcpConfigMock.mockResolvedValue({
      servers: {
        existing: { type: 'streamable-http', url: 'https://existing.example/mcp' },
        'lyclaw-skill-marketplace': { type: 'stdio', command: 'bad-launcher', args: ['server.js'] },
        'document-analyst--1234--company-docs': {
          transport: 'streamable-http',
          url: 'https://local.example/mcp',
          headers: { Authorization: 'Bearer local-token' },
          disabled: false,
          tools: { allow: ['old_tool'] },
        },
        'document-analyst--1234--removed': {
          command: process.execPath,
          args: ['removed.js'],
          disabled: true,
        },
      },
    });
    const { updateEmployeeMcpServers } = await import('@electron/utils/digital-employee-mcp');

    const result = await updateEmployeeMcpServers({
      instanceId: 'document-analyst--1234',
      agentId: 'employee-document-analyst-1234',
      manifest: {
        ...manifest,
        mcp: {
          ...manifest.mcp!,
          bindings: [{
            server: 'company docs',
            required: false,
            enabled: true,
            allowedTools: ['new_tool'],
          }],
        },
      },
      previousPackageConfig: {
        servers: {
          'company docs': {
            type: 'streamable-http',
            url: 'https://old-template.example/mcp',
            headers: { Authorization: 'Bearer ${OLD_TOKEN}' },
            disabled: true,
          },
          removed: {
            type: 'stdio',
            command: process.execPath,
            args: ['removed.js'],
            disabled: true,
          },
        },
      },
      packageConfig: {
        servers: {
          'company docs': {
            type: 'streamable-http',
            url: 'https://new-template.example/mcp',
            headers: { Authorization: 'Bearer ${NEW_TOKEN}' },
            disabled: true,
          },
        },
      },
      installPath: 'C:/employees/document-analyst--1234',
      installedServers: [
        {
          sourceName: 'company docs',
          runtimeName: 'document-analyst--1234--company-docs',
        },
        {
          sourceName: 'removed',
          runtimeName: 'document-analyst--1234--removed',
        },
      ],
    });

    expect(result.installedServers).toEqual([{
      sourceName: 'company docs',
      runtimeName: 'document-analyst--1234--company-docs',
    }]);
    expect(writeMcpConfigAtomicMock).toHaveBeenCalledWith(
      'openclaw.json#mcp.servers',
      {
        servers: {
          existing: { type: 'streamable-http', url: 'https://existing.example/mcp' },
          'lyclaw-skill-marketplace': { type: 'stdio', command: 'bad-launcher', args: ['server.js'] },
          'document-analyst--1234--company-docs': expect.objectContaining({
            url: 'https://local.example/mcp',
            headers: { Authorization: 'Bearer local-token' },
            disabled: false,
            toolFilter: { include: ['new_tool'] },
            'x-lyclaw-hidden-from-connectors': true,
          }),
        },
      },
    );
  });

  it('writes employee-local runtime MCP config with enabled stdio cwd', async () => {
    const {
      buildEmployeeRuntimeMcpConfig,
      resolveDigitalEmployeeNodeExecutable,
      writeEmployeeRuntimeMcpConfig,
    } = await import('@electron/utils/digital-employee-mcp');
    const installPath = 'C:/employees/emp_123';
    const expectedNode = resolveDigitalEmployeeNodeExecutable();
    const packageConfig = {
      servers: {
        'company docs': {
          type: 'stdio' as const,
          command: 'node',
          args: ['mcp/server.mjs'],
          disabled: true,
          tools: { allow: ['unwanted_tool'] },
        },
      },
    };

    expect(buildEmployeeRuntimeMcpConfig({
      manifest,
      packageConfig,
      installPath,
    })).toEqual({
      servers: {
        'company docs': {
          type: 'stdio',
          command: expectedNode,
          args: ['mcp/server.mjs'],
          disabled: false,
          cwd: installPath,
          toolFilter: { include: ['search_documents'] },
        },
      },
    });

    const targetRoot = await mkdtemp(join(tmpdir(), 'lyclaw-employee-mcp-'));
    try {
      await writeEmployeeRuntimeMcpConfig({
        manifest,
        packageConfig,
        installPath,
        targetRoot,
      });

      expect(JSON.parse(await readFile(join(targetRoot, 'mcp', 'servers.json'), 'utf8'))).toEqual({
        servers: {
          'company docs': {
            type: 'stdio',
            command: expectedNode,
            args: ['mcp/server.mjs'],
            disabled: false,
            cwd: installPath,
            toolFilter: { include: ['search_documents'] },
          },
        },
      });
    } finally {
      await rm(targetRoot, { recursive: true, force: true });
    }
  });
  it('expands portable node runtime MCP entries to the platform Node executable', async () => {
    const {
      buildEmployeeRuntimeMcpConfig,
      installEmployeeMcpServers,
      resolveDigitalEmployeeNodeExecutable,
    } = await import('@electron/utils/digital-employee-mcp');
    const installPath = 'C:/employees/emp_123';
    const expectedNode = resolveDigitalEmployeeNodeExecutable();
    expect(expectedNode).toBeTruthy();

    const packageConfig = {
      servers: {
        'company docs': {
          type: 'stdio' as const,
          runtime: 'node' as const,
          entry: 'mcp/server.mjs',
          args: ['--mode', 'employee'],
          env: { FOO: 'bar' },
          disabled: true,
        },
      },
    };

    expect(buildEmployeeRuntimeMcpConfig({
      manifest,
      packageConfig,
      installPath,
    })).toEqual({
      servers: {
        'company docs': {
          type: 'stdio',
          command: expectedNode,
          args: [join(installPath, 'mcp/server.mjs'), '--mode', 'employee'],
          env: { FOO: 'bar', CLAWX_NODE: expectedNode, EMPLOYEE_DIR: installPath },
          disabled: false,
          cwd: installPath,
          toolFilter: { include: ['search_documents'] },
        },
      },
    });

    await installEmployeeMcpServers({
      instanceId: 'emp_123',
      agentId: 'employee-emp-123',
      manifest,
      installPath,
      packageConfig,
    });

    expect(writeMcpConfigAtomicMock).toHaveBeenCalledWith(
      'openclaw.json#mcp.servers',
      expect.objectContaining({
        servers: expect.objectContaining({
          'emp_123--company-docs': expect.objectContaining({
            command: expectedNode,
            args: [join(installPath, 'mcp/server.mjs'), '--mode', 'employee'],
            env: { FOO: 'bar', CLAWX_NODE: expectedNode, EMPLOYEE_DIR: installPath },
            cwd: installPath,
            disabled: false,
            'x-lyclaw-hidden-from-connectors': true,
          }),
        }),
      }),
    );
  });

  it('writes runtime MCP config to the manifest serverTemplate path', async () => {
    const { resolveDigitalEmployeeNodeExecutable, writeEmployeeRuntimeMcpConfig } = await import('@electron/utils/digital-employee-mcp');
    const expectedNode = resolveDigitalEmployeeNodeExecutable();
    const targetRoot = await mkdtemp(join(tmpdir(), 'lyclaw-employee-mcp-template-'));
    try {
      await writeEmployeeRuntimeMcpConfig({
        manifest: {
          ...manifest,
          mcp: {
            ...manifest.mcp!,
            serverTemplate: 'mcp/servers.template.json',
          },
        },
        packageConfig: {
          servers: {
            'company docs': {
              type: 'stdio',
              command: 'node',
              args: ['mcp/server.mjs'],
              disabled: true,
            },
          },
        },
        installPath: 'C:/employees/emp_123',
        targetRoot,
      });

      expect(JSON.parse(await readFile(join(targetRoot, 'mcp', 'servers.template.json'), 'utf8'))).toMatchObject({
        servers: {
          'company docs': {
            command: expectedNode,
            disabled: false,
            cwd: 'C:/employees/emp_123',
          },
        },
      });
    } finally {
      await rm(targetRoot, { recursive: true, force: true });
    }
  });
});
