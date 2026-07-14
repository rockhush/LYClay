import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalPlatform = process.platform;

const { mockTerminateGatewayListenersOnPort, mockTerminateGatewayProcessByPid } = vi.hoisted(() => ({
  mockTerminateGatewayListenersOnPort: vi.fn(),
  mockTerminateGatewayProcessByPid: vi.fn(),
}));

vi.mock('@electron/gateway/supervisor', () => ({
  terminateGatewayListenersOnPort: mockTerminateGatewayListenersOnPort,
  terminateGatewayProcessByPid: mockTerminateGatewayProcessByPid,
}));

vi.mock('@electron/utils/agent-config', () => ({
  assignChannelToAgent: vi.fn(),
  clearChannelBinding: vi.fn(),
  createAgent: vi.fn(),
  deleteAgentConfig: vi.fn(),
  listAgentsSnapshot: vi.fn(),
  removeAgentWorkspaceDirectory: vi.fn(),
  resolveAccountIdForAgent: vi.fn(),
  updateAgentName: vi.fn(),
}));

vi.mock('@electron/utils/digital-employee-storage', () => ({
  listDigitalEmployeeAgentIds: vi.fn(),
}));

vi.mock('@electron/utils/channel-config', () => ({
  deleteChannelAccountConfig: vi.fn(),
}));

vi.mock('@electron/services/providers/provider-runtime-sync', () => ({
  syncAllProviderAuthToRuntime: vi.fn(),
}));

vi.mock('@electron/api/route-utils', () => ({
  parseJsonBody: vi.fn(),
  sendJson: vi.fn(),
}));

function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, writable: true });
}

describe('restartGatewayForAgentDeletion', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    mockTerminateGatewayListenersOnPort.mockResolvedValue(undefined);
    mockTerminateGatewayProcessByPid.mockResolvedValue(undefined);
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true });
  });

  it('delegates known gateway pid cleanup to the supervised command boundary', async () => {
    setPlatform('win32');
    const { restartGatewayForAgentDeletion } = await import('@electron/api/routes/agents');

    const restart = vi.fn().mockResolvedValue(undefined);
    const getStatus = vi.fn(() => ({ pid: 4321, port: 18789 }));

    await restartGatewayForAgentDeletion({
      gatewayManager: {
        getStatus,
        restart,
      },
    } as never);

    expect(mockTerminateGatewayProcessByPid).toHaveBeenCalledWith(4321, 'system:agent-delete-gateway-restart');
    expect(mockTerminateGatewayListenersOnPort).not.toHaveBeenCalled();
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('delegates port cleanup to the supervised command boundary when pid is unknown', async () => {
    setPlatform('win32');
    const { restartGatewayForAgentDeletion } = await import('@electron/api/routes/agents');

    const restart = vi.fn().mockResolvedValue(undefined);
    const getStatus = vi.fn(() => ({ port: 18789 }));

    await restartGatewayForAgentDeletion({
      gatewayManager: {
        getStatus,
        restart,
      },
    } as never);

    expect(mockTerminateGatewayProcessByPid).not.toHaveBeenCalled();
    expect(mockTerminateGatewayListenersOnPort).toHaveBeenCalledWith(18789);
    expect(restart).toHaveBeenCalledTimes(1);
  });
});

describe('handleAgentRoutes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
  });

  it('excludes digital employee agents when scope=managed', async () => {
    const { listAgentsSnapshot } = await import('@electron/utils/agent-config');
    const { listDigitalEmployeeAgentIds } = await import('@electron/utils/digital-employee-storage');
    const { sendJson } = await import('@electron/api/route-utils');
    const { handleAgentRoutes } = await import('@electron/api/routes/agents');

    vi.mocked(listAgentsSnapshot).mockResolvedValue({
      agents: [
        { id: 'main', name: 'Main', isDefault: true, modelDisplay: 'auto', modelRef: null, overrideModelRef: null, inheritedModel: false, workspace: '', agentDir: '', mainSessionKey: 'agent:main:main', channelTypes: [] },
        { id: 'employee-doc-1', name: '文档分析岗位助理', isDefault: false, modelDisplay: 'auto', modelRef: null, overrideModelRef: null, inheritedModel: true, workspace: '', agentDir: '', mainSessionKey: 'agent:employee-doc-1:main', channelTypes: [] },
      ],
      defaultAgentId: 'main',
      defaultModelRef: null,
      configuredChannelTypes: [],
      channelOwners: {},
      channelAccountOwners: {},
    });
    vi.mocked(listDigitalEmployeeAgentIds).mockResolvedValue(new Set(['employee-doc-1']));

    const handled = await handleAgentRoutes(
      { method: 'GET' } as never,
      {} as never,
      new URL('http://127.0.0.1:13210/api/agents?scope=managed'),
      {} as never,
    );

    expect(handled).toBe(true);
    expect(listDigitalEmployeeAgentIds).toHaveBeenCalledTimes(1);
    expect(sendJson).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({
        success: true,
        agents: [expect.objectContaining({ id: 'main' })],
      }),
    );
  });
});
