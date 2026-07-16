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

vi.mock('@/lib/ui-state-persistence', () => ({
  scheduleUiStateSync: vi.fn(),
}));

describe('digital employees store', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { loadRetiredDigitalEmployees } = await import('@/lib/retired-digital-employees');
    loadRetiredDigitalEmployees({ retiredAgents: {} });
    const { useDigitalEmployeesStore } = await import('@/stores/digital-employees');
    useDigitalEmployeesStore.setState({
      employees: [],
      loading: false,
      installingMarketEmployeeId: null,
      updatingInstanceId: null,
      error: null,
      retiredSessionsRevision: 0,
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
      if (path === '/api/digital-employees') return [];
      throw new Error(`Unexpected Host API path: ${path}`);
    });
    const { useDigitalEmployeesStore } = await import('@/stores/digital-employees');
    const { getRetiredDigitalEmployeesSnapshot } = await import('@/lib/retired-digital-employees');
    useDigitalEmployeesStore.setState({
      employees: [{
        instanceId: 'document-analyst--abc',
        marketEmployeeId: '7',
        packageId: 'pkg-1',
        packageVersion: '1.0.0',
        name: '招聘数字员工',
        description: 'Test',
        tags: [],
        installPath: '/tmp/emp-1',
        agentId: 'employee-document-analyst-abc',
        sessionKey: 'agent:employee-document-analyst-abc:main',
        status: 'active',
        enabled: true,
        warnings: [],
      }],
    });

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
    expect(getRetiredDigitalEmployeesSnapshot().retiredAgents['employee-document-analyst-abc']).toMatchObject({
      agentId: 'employee-document-analyst-abc',
      name: '招聘数字员工',
      marketEmployeeId: '7',
    });
  });

  it('reactivates all retired sessions for the same marketplace employee on reinstall', async () => {
    const { loadRetiredDigitalEmployees, getRetiredDigitalEmployeesSnapshot, retireDigitalEmployee } = await import(
      '@/lib/retired-digital-employees'
    );
    const { scheduleUiStateSync } = await import('@/lib/ui-state-persistence');
    retireDigitalEmployee({
      agentId: 'employee-recruitment-specialist-old',
      name: '招聘数字员工',
      marketEmployeeId: '7',
    });
    retireDigitalEmployee({
      agentId: 'employee-recruitment-specialist-older',
      name: '招聘数字员工',
      marketEmployeeId: '7',
    });

    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/digital-employees/install') {
        return {
          instanceId: 'recruitment--new',
          agentId: 'employee-recruitment-specialist-new',
          sessionKey: 'agent:employee-recruitment-specialist-new:main',
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

    expect(getRetiredDigitalEmployeesSnapshot().retiredAgents['employee-recruitment-specialist-old']).toMatchObject({
      agentId: 'employee-recruitment-specialist-old',
      name: '招聘数字员工',
      marketEmployeeId: '7',
      readOnly: false,
    });
    expect(getRetiredDigitalEmployeesSnapshot().retiredAgents['employee-recruitment-specialist-older']).toMatchObject({
      readOnly: false,
    });
    expect(useDigitalEmployeesStore.getState().retiredSessionsRevision).toBe(1);
    expect(scheduleUiStateSync).toHaveBeenCalled();
    loadRetiredDigitalEmployees({ retiredAgents: {} });
  });

  it('re-retires all historical sessions for the same marketplace employee on uninstall', async () => {
    const {
      loadRetiredDigitalEmployees,
      getRetiredDigitalEmployeesSnapshot,
      retireDigitalEmployee,
      unretireDigitalEmployeesByMarketId,
    } = await import('@/lib/retired-digital-employees');
    retireDigitalEmployee({
      agentId: 'employee-recruitment-specialist-session-a',
      name: '招聘数字员工',
      marketEmployeeId: '7',
    });
    unretireDigitalEmployeesByMarketId('7');

    hostApiFetchMock.mockImplementation(async (path: string, options?: { method?: string; body?: string }) => {
      if (path === '/api/digital-employees/uninstall' && options?.method === 'POST') {
        return {
          instanceId: 'recruitment--new',
          agentId: 'employee-recruitment-specialist-session-b',
          marketEmployeeId: '7',
        };
      }
      if (path === '/api/digital-employees') return [];
      throw new Error(`Unexpected Host API path: ${path}`);
    });
    fetchAgentsMock.mockResolvedValue(undefined);
    const { useDigitalEmployeesStore } = await import('@/stores/digital-employees');
    useDigitalEmployeesStore.setState({
      employees: [{
        instanceId: 'recruitment--new',
        marketEmployeeId: '7',
        packageId: 'pkg-1',
        packageVersion: '1.0.0',
        name: '招聘数字员工',
        description: 'Test',
        tags: [],
        installPath: '/tmp/emp-1',
        agentId: 'employee-recruitment-specialist-session-b',
        sessionKey: 'agent:employee-recruitment-specialist-session-b:main',
        status: 'active',
        enabled: true,
        warnings: [],
      }],
    });

    await useDigitalEmployeesStore.getState().uninstallMarketplaceEmployee({
      instanceId: 'recruitment--new',
    });

    expect(getRetiredDigitalEmployeesSnapshot().retiredAgents['employee-recruitment-specialist-session-a']).toMatchObject({
      readOnly: true,
    });
    expect(getRetiredDigitalEmployeesSnapshot().retiredAgents['employee-recruitment-specialist-session-b']).toMatchObject({
      readOnly: true,
    });
    expect(useDigitalEmployeesStore.getState().retiredSessionsRevision).toBe(1);
    loadRetiredDigitalEmployees({ retiredAgents: {} });
  });
});
