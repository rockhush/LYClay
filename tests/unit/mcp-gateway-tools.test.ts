import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdkMocks = vi.hoisted(() => ({
  connect: vi.fn(),
  listTools: vi.fn(),
  close: vi.fn(),
  sseTransport: vi.fn(),
  streamableHttpTransport: vi.fn(),
}));

const validateNetworkMock = vi.hoisted(() => vi.fn());

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class MockClient {
    connect = sdkMocks.connect;
    listTools = sdkMocks.listTools;
    close = sdkMocks.close;
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: class MockSseTransport {
    constructor(...args: unknown[]) {
      sdkMocks.sseTransport(...args);
    }
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class MockStreamableHttpTransport {
    constructor(...args: unknown[]) {
      sdkMocks.streamableHttpTransport(...args);
    }
  },
}));

vi.mock('@electron/utils/mcp-config-validator', () => ({
  validateMcpConfigNetworkPolicy: (...args: unknown[]) => validateNetworkMock(...args),
}));

vi.mock('@electron/security/secret-scanner', () => ({
  redactSecrets: (value: string) => value.replace(/token=[^&\s]+/gi, 'token=***'),
}));

vi.mock('@electron/utils/logger', () => ({
  logger: { debug: vi.fn() },
}));

const GLOBAL_TOOLS = [
  'agents_list',
  'apply_patch',
  'code_execution',
  'create_goal',
  'dir_fetch',
  'dir_list',
  'file_fetch',
  'file_write',
  'get_goal',
  'heartbeat_respond',
  'image_generate',
  'memory_get',
  'memory_search',
  'music_generate',
  'session_status',
  'sessions_history',
  'sessions_list',
  'sessions_send',
  'sessions_spawn',
  'sessions_yield',
  'skill_workshop',
  'update_goal',
  'update_plan',
  'video_generate',
  'web_fetch',
  'web_search',
  'x_search',
];

function gatewayReturning(value: unknown) {
  return {
    rpc: vi.fn().mockResolvedValue(value),
  };
}

describe('discoverMcpToolsForServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    validateNetworkMock.mockResolvedValue({ valid: true, errors: [] });
    sdkMocks.connect.mockResolvedValue(undefined);
    sdkMocks.close.mockResolvedValue(undefined);
  });

  it('ignores an unscoped Gateway catalog and returns the six tools from the MCP server', async () => {
    sdkMocks.listTools.mockResolvedValue({
      tools: [
        'check_connection',
        'list_connections',
        'get_databases',
        'get_tables',
        'get_schema',
        'query',
      ].map((name) => ({ name })),
    });

    const { discoverMcpToolsForServer } = await import('@electron/utils/mcp-gateway-tools');
    const result = await discoverMcpToolsForServer(
      gatewayReturning({ tools: GLOBAL_TOOLS.map((name) => ({ name, description: name })) }) as never,
      'mysql-server',
      { type: 'sse', url: 'http://10.3.32.208:8080/sse' },
    );

    expect(result).toEqual({
      source: 'direct',
      tools: [
        'check_connection',
        'get_databases',
        'get_schema',
        'get_tables',
        'list_connections',
        'query',
      ],
    });
    expect(result.tools).not.toContain('agents_list');
    expect(sdkMocks.sseTransport).toHaveBeenCalledOnce();
  });

  it('uses an exact Gateway server bucket without opening a direct connection', async () => {
    const { discoverMcpToolsForServer } = await import('@electron/utils/mcp-gateway-tools');
    const result = await discoverMcpToolsForServer(
      gatewayReturning({
        servers: {
          'mysql-server': { tools: [{ name: 'query' }, { name: 'get_tables' }] },
        },
      }) as never,
      'mysql-server',
      { type: 'sse', url: 'http://10.3.32.208:8080/sse' },
    );

    expect(result).toEqual({ source: 'gateway', tools: ['get_tables', 'query'] });
    expect(sdkMocks.connect).not.toHaveBeenCalled();
  });

  it('follows tools/list pagination', async () => {
    sdkMocks.listTools
      .mockResolvedValueOnce({ tools: [{ name: 'get_tables' }], nextCursor: 'page-2' })
      .mockResolvedValueOnce({ tools: [{ name: 'query' }] });

    const { discoverMcpToolsForServer } = await import('@electron/utils/mcp-gateway-tools');
    const result = await discoverMcpToolsForServer(
      gatewayReturning({ tools: GLOBAL_TOOLS }) as never,
      'mysql-server',
      { type: 'streamable-http', url: 'https://example.com/mcp' },
    );

    expect(result).toEqual({ source: 'direct', tools: ['get_tables', 'query'] });
    expect(sdkMocks.listTools).toHaveBeenNthCalledWith(2, { cursor: 'page-2' }, expect.any(Object));
    expect(sdkMocks.streamableHttpTransport).toHaveBeenCalledOnce();
  });

  it('reports discovery failure instead of falling back to global tools', async () => {
    sdkMocks.connect.mockRejectedValue(new Error('connection refused for token=secret'));

    const { discoverMcpToolsForServer } = await import('@electron/utils/mcp-gateway-tools');
    const result = await discoverMcpToolsForServer(
      gatewayReturning({ tools: GLOBAL_TOOLS }) as never,
      'mysql-server',
      { type: 'sse', url: 'http://10.3.32.208:8080/sse?token=secret' },
    );

    expect(result.source).toBe('unavailable');
    expect(result.tools).toEqual([]);
    expect(result.error).toContain('token=***');
    expect(result.error).not.toContain('token=secret');
    expect(sdkMocks.close).toHaveBeenCalledOnce();
  });

  it('does not connect directly to a disabled MCP server', async () => {
    const { discoverMcpToolsForServer } = await import('@electron/utils/mcp-gateway-tools');
    const result = await discoverMcpToolsForServer(
      gatewayReturning({ tools: GLOBAL_TOOLS }) as never,
      'mysql-server',
      { type: 'sse', url: 'http://10.3.32.208:8080/sse', disabled: true },
    );

    expect(result).toEqual({
      source: 'unavailable',
      tools: [],
      error: 'Enable this MCP server before discovering its tools',
    });
    expect(validateNetworkMock).not.toHaveBeenCalled();
    expect(sdkMocks.connect).not.toHaveBeenCalled();
  });
});
