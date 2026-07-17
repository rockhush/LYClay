import { beforeEach, describe, expect, it, vi } from 'vitest';

const hostApiFetchMock = vi.fn();

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
}));

describe('agents store runtime response validation', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('keeps agents array-shaped when the host returns malformed collection fields', async () => {
    hostApiFetchMock.mockResolvedValue({
      success: true,
      agents: { main: { id: 'main', name: 'Main' } },
      configuredChannelTypes: { feishu: true },
      defaultAgentId: 'main',
    });

    const { useAgentsStore } = await import('@/stores/agents');
    await useAgentsStore.getState().fetchAgents({ force: true });

    expect(useAgentsStore.getState()).toMatchObject({
      agents: [],
      configuredChannelTypes: [],
      defaultAgentId: 'main',
      loading: false,
    });
  });
});
