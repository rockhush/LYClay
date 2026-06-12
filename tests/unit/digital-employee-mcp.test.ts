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

  it('namespaces packaged MCP servers and registers them disabled', async () => {
    const { installEmployeeMcpServers } = await import('@electron/utils/digital-employee-mcp');

    const result = await installEmployeeMcpServers({
      instanceId: 'emp_123',
      manifest,
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
            disabled: true,
            tools: { allow: ['search_documents'] },
          }),
        },
      },
    );
  });

  it('rejects real credentials embedded in a marketplace package', async () => {
    const { installEmployeeMcpServers } = await import('@electron/utils/digital-employee-mcp');

    await expect(installEmployeeMcpServers({
      instanceId: 'emp_123',
      manifest,
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
        'document-analyst--1234--company-docs': {
          transport: 'streamable-http',
          url: 'https://local.example/mcp',
          headers: { Authorization: 'Bearer local-token' },
          disabled: false,
          tools: { allow: ['old_tool'] },
        },
        'document-analyst--1234--removed': {
          command: 'node',
          args: ['removed.js'],
          disabled: true,
        },
      },
    });
    const { updateEmployeeMcpServers } = await import('@electron/utils/digital-employee-mcp');

    const result = await updateEmployeeMcpServers({
      instanceId: 'document-analyst--1234',
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
            command: 'node',
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
          'document-analyst--1234--company-docs': expect.objectContaining({
            url: 'https://local.example/mcp',
            headers: { Authorization: 'Bearer local-token' },
            disabled: false,
            tools: { allow: ['new_tool'] },
          }),
        },
      },
    );
  });
});
