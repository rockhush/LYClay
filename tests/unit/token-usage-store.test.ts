import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTokenUsageStoreForTests, useTokenUsageStore } from '@/stores/token-usage';

const hostApiFetchMock = vi.fn();

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
}));

vi.mock('@/lib/telemetry', () => ({
  trackUiEvent: vi.fn(),
}));

describe('token usage store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetTokenUsageStoreForTests();
  });

  it('loads token usage once and serves cached data on subsequent calls', async () => {
    hostApiFetchMock.mockResolvedValue([{
      timestamp: '2026-04-01T12:00:00.000Z',
      sessionId: 'session-1',
      agentId: 'main',
      inputTokens: 1,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 1,
    }]);

    await useTokenUsageStore.getState().fetchTokenUsageHistory();
    await useTokenUsageStore.getState().fetchTokenUsageHistory();

    expect(hostApiFetchMock).toHaveBeenCalledTimes(1);
    expect(useTokenUsageStore.getState().loaded).toBe(true);
    expect(useTokenUsageStore.getState().entries).toHaveLength(1);
  });

  it('refetches when force refresh is requested', async () => {
    hostApiFetchMock.mockResolvedValue([]);

    await useTokenUsageStore.getState().fetchTokenUsageHistory();
    await useTokenUsageStore.getState().fetchTokenUsageHistory({ force: true });

    expect(hostApiFetchMock).toHaveBeenCalledTimes(2);
  });
});
