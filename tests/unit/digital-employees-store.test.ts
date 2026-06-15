import { beforeEach, describe, expect, it, vi } from 'vitest';

const { hostApiFetchMock, fetchAgentsMock } = vi.hoisted(() => ({
  hostApiFetchMock: vi.fn(),
  fetchAgentsMock: vi.fn(),
}));

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
}));

vi.mock('@/stores/agents', () => ({
  useAgentsStore: {
    getState: () => ({
      fetchAgents: fetchAgentsMock,
    }),
  },
}));

describe('digital employees store', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { useDigitalEmployeesStore } = await import('@/stores/digital-employees');
    useDigitalEmployeesStore.setState({
      employees: [],
      loading: false,
      installingMarketEmployeeId: null,
      updatingInstanceId: null,
      error: null,
    });
  });

  it('passes only the marketplace employee id to the install route', async () => {
    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/digital-employees/install') {
        return {
          instanceId: 'document-analyst--12345678',
          agentId: 'employee-document-analyst-12345678',
          sessionKey: 'agent:employee-document-analyst-12345678:main',
          status: 'active',
          warnings: [],
        };
      }
      if (path === '/api/digital-employees') return [];
      throw new Error(`Unexpected Host API path: ${path}`);
    });
    fetchAgentsMock.mockResolvedValue(undefined);
    const { useDigitalEmployeesStore } = await import('@/stores/digital-employees');

    await useDigitalEmployeesStore.getState().installMarketplaceEmployee({
      marketEmployeeId: 7,
    });

    expect(hostApiFetchMock).toHaveBeenCalledWith(
      '/api/digital-employees/install',
      {
        method: 'POST',
        body: JSON.stringify({ marketEmployeeId: 7 }),
      },
    );
    expect(fetchAgentsMock).toHaveBeenCalledWith({ force: true });
  });

  it('persists enabled state through the enabled route', async () => {
    hostApiFetchMock.mockImplementation(async (path: string, options?: { method?: string; body?: string }) => {
      if (path === '/api/digital-employees/emp-1/enabled' && options?.method === 'PUT') {
        return {
          success: true,
          instanceId: 'emp-1',
          enabled: JSON.parse(options.body || '{}').enabled,
        };
      }
      throw new Error(`Unexpected Host API path: ${path}`);
    });
    const { useDigitalEmployeesStore } = await import('@/stores/digital-employees');
    useDigitalEmployeesStore.setState({
      employees: [{
        instanceId: 'emp-1',
        marketEmployeeId: 'market-1',
        packageId: 'pkg-1',
        packageVersion: '1.0.0',
        name: 'Test',
        description: 'Test',
        tags: [],
        installPath: '/tmp/emp-1',
        agentId: 'agent-1',
        sessionKey: 'agent:agent-1:main',
        status: 'active',
        enabled: true,
        warnings: [],
      }],
    });

    await useDigitalEmployeesStore.getState().setEmployeeEnabled('emp-1', false);

    expect(hostApiFetchMock).toHaveBeenCalledWith(
      '/api/digital-employees/emp-1/enabled',
      {
        method: 'PUT',
        body: JSON.stringify({ enabled: false }),
      },
    );
    expect(useDigitalEmployeesStore.getState().employees[0]?.enabled).toBe(false);
  });

  it('uninstalls a specific instance by instanceId', async () => {
    hostApiFetchMock.mockImplementation(async (path: string, options?: { method?: string; body?: string }) => {
      if (path === '/api/digital-employees/uninstall' && options?.method === 'POST') {
        return {
          instanceId: JSON.parse(options.body || '{}').instanceId,
          agentId: 'employee-document-analyst-abc',
          marketEmployeeId: '7',
        };
      }
      throw new Error(`Unexpected Host API path: ${path}`);
    });
    const { useDigitalEmployeesStore } = await import('@/stores/digital-employees');

    await useDigitalEmployeesStore.getState().uninstallMarketplaceEmployee({
      instanceId: 'document-analyst--abc',
    });

    expect(hostApiFetchMock).toHaveBeenCalledWith(
      '/api/digital-employees/uninstall',
      {
        method: 'POST',
        body: JSON.stringify({ instanceId: 'document-analyst--abc' }),
      },
    );
  });
});
