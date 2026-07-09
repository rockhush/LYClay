import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

const sendJsonMock = vi.fn();
const writeMcpConfigAtomicMock = vi.fn();
const assertMcpServerAllowedWithConfirmationMock = vi.fn();
const readMcpConfigMock = vi.fn();
const validateMcpConfigNetworkPolicyMock = vi.fn();
const parseJsonBodyMock = vi.fn();

vi.mock('@electron/api/route-utils', () => ({
  parseJsonBody: (...args: unknown[]) => parseJsonBodyMock(...args),
  sendJson: (...args: unknown[]) => sendJsonMock(...args),
}));

vi.mock('@electron/utils/mcp-json', () => ({
  LYCLAW_BUILTIN_MCP_KEYS: new Set(['notion', 'github']),
  getMcpConfigPath: () => 'openclaw.json#mcp.servers',
  readMcpConfig: (...args: unknown[]) => readMcpConfigMock(...args),
  writeMcpConfigAtomic: (...args: unknown[]) => writeMcpConfigAtomicMock(...args),
  deleteMcpServerEverywhere: vi.fn(),
}));

vi.mock('@electron/utils/mcp-config-validator', () => ({
  coerceMcpConfig: (config: unknown) => config,
  validateMcpConfigNetworkPolicy: (...args: unknown[]) => validateMcpConfigNetworkPolicyMock(...args),
}));

vi.mock('@electron/security/confirmation-service', () => ({
  assertMcpServerAllowedWithConfirmation: (...args: unknown[]) => assertMcpServerAllowedWithConfirmationMock(...args),
}));

vi.mock('@electron/utils/mcp-gateway-tools', () => ({
  fetchGatewayToolNamesForServer: vi.fn(),
}));

describe('MCP server authorization routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    readMcpConfigMock.mockResolvedValue({
      servers: {
        example: {
          command: 'npx',
          args: ['-y', '@example/mcp'],
          disabled: true,
        },
      },
    });
    validateMcpConfigNetworkPolicyMock.mockResolvedValue({ valid: true, errors: [] });
    assertMcpServerAllowedWithConfirmationMock.mockResolvedValue(undefined);
  });

  it('requires MCP authorization before enabling a stdio server', async () => {
    const debouncedReload = vi.fn();
    const { handleMcpRoutes } = await import('@electron/api/routes/mcp');
    const handled = await handleMcpRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:13210/api/mcp/servers/example/enable'),
      { gatewayManager: { debouncedReload } } as never,
    );

    expect(handled).toBe(true);
    expect(assertMcpServerAllowedWithConfirmationMock).toHaveBeenCalledWith({
      serverName: 'example',
      server: {
        command: 'npx',
        args: ['-y', '@example/mcp'],
        disabled: false,
      },
      source: 'settings:mcp-enable',
    });
    expect(writeMcpConfigAtomicMock).toHaveBeenCalledTimes(1);
    expect(debouncedReload).toHaveBeenCalledTimes(1);
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, { success: true });
  });

  it('does not save the enabled config when authorization is rejected', async () => {
    assertMcpServerAllowedWithConfirmationMock.mockRejectedValue(new Error('denied'));
    const { handleMcpRoutes } = await import('@electron/api/routes/mcp');
    await handleMcpRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:13210/api/mcp/servers/example/enable'),
      { gatewayManager: { debouncedReload: vi.fn() } } as never,
    );

    expect(writeMcpConfigAtomicMock).not.toHaveBeenCalled();
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 500, {
      success: false,
      error: 'Error: denied',
    });
  });
  it('hides digital employee MCP servers from the connectors list', async () => {
    readMcpConfigMock.mockResolvedValue({
      servers: {
        visible: { command: 'npx', args: ['visible'] },
        employee: {
          command: 'node',
          args: ['mcp/server.mjs'],
          'x-lyclaw-hidden-from-connectors': true,
          'x-lyclaw-owner': { type: 'digitalEmployee' },
        },
      },
    });
    const { handleMcpRoutes } = await import('@electron/api/routes/mcp');

    await handleMcpRoutes(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:13210/api/mcp/servers'),
      { gatewayManager: { debouncedReload: vi.fn() } } as never,
    );

    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, [
      expect.objectContaining({ name: 'visible' }),
    ]);
  });

  it('preserves hidden digital employee MCP servers when saving visible config', async () => {
    const hidden = {
      command: 'node',
      args: ['mcp/server.mjs'],
      'x-lyclaw-hidden-from-connectors': true,
      'x-lyclaw-owner': { type: 'digitalEmployee' },
    };
    readMcpConfigMock.mockResolvedValue({
      servers: {
        employee: hidden,
      },
    });
    parseJsonBodyMock.mockResolvedValue({
      config: {
        servers: {
          visible: { command: 'npx', args: ['visible'], disabled: true },
        },
      },
    });
    const debouncedReload = vi.fn();
    const { handleMcpRoutes } = await import('@electron/api/routes/mcp');

    await handleMcpRoutes(
      { method: 'PUT' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:13210/api/mcp/config'),
      { gatewayManager: { debouncedReload } } as never,
    );

    expect(writeMcpConfigAtomicMock).toHaveBeenCalledWith(
      'openclaw.json#mcp.servers',
      {
        servers: {
          visible: { command: 'npx', args: ['visible'], disabled: true },
          employee: hidden,
        },
      },
    );
    expect(debouncedReload).toHaveBeenCalledTimes(1);
  });
});
