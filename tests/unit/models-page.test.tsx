import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Models } from '@/pages/Models/index';
import { resetTokenUsageStoreForTests, useTokenUsageStore } from '@/stores/token-usage';

const hostApiFetchMock = vi.fn();
const trackUiEventMock = vi.fn();

const { gatewayState, settingsState } = vi.hoisted(() => ({
  gatewayState: {
    status: { state: 'running', port: 18789, connectedAt: 1, pid: 1234 },
  },
  settingsState: {
    devModeUnlocked: false,
  },
}));

vi.mock('@/stores/gateway', () => ({
  useGatewayStore: (selector: (state: typeof gatewayState) => unknown) => selector(gatewayState),
}));

vi.mock('@/stores/settings', () => ({
  useSettingsStore: (selector: (state: typeof settingsState) => unknown) => selector(settingsState),
}));

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
}));

vi.mock('@/lib/telemetry', () => ({
  trackUiEvent: (...args: unknown[]) => trackUiEventMock(...args),
}));

vi.mock('@/components/settings/ProvidersSettings', () => ({
  ProvidersSettings: () => null,
}));

vi.mock('@/components/common/FeedbackState', () => ({
  FeedbackState: ({ title }: { title: string }) => <div>{title}</div>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | { count?: number }) => {
      if (typeof fallback === 'string') return fallback;
      return key;
    },
  }),
}));

function createUsageEntry(index: number) {
  return {
    timestamp: '2026-04-01T12:00:00.000Z',
    sessionId: `session-${index}`,
    agentId: 'main',
    model: 'gpt-5',
    provider: 'openai',
    inputTokens: index,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: index,
  };
}

function createUsageHistory(count: number) {
  return Array.from({ length: count }, (_, index) => createUsageEntry(index + 1));
}

describe('Models page token usage cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetTokenUsageStoreForTests();
    gatewayState.status = { state: 'running', port: 18789, connectedAt: 1, pid: 1234 };
    hostApiFetchMock.mockResolvedValue([createUsageEntry(27)]);
  });

  afterEach(() => {
    resetTokenUsageStoreForTests();
  });

  it('fetches token usage when opening the models page', async () => {
    useTokenUsageStore.setState({
      status: 'done',
      entries: createUsageHistory(10),
      stableEntries: createUsageHistory(10),
      loaded: true,
    });

    hostApiFetchMock.mockResolvedValueOnce(createUsageHistory(10));

    render(<Models />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(hostApiFetchMock).toHaveBeenCalledTimes(1);
    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/usage/recent-token-history');
    expect(screen.getAllByTestId('token-usage-entry')).toHaveLength(5);
  });

  it('shows cached token usage when gateway is not running', async () => {
    gatewayState.status = { state: 'stopped', port: 18789 };
    useTokenUsageStore.setState({
      status: 'done',
      entries: createUsageHistory(3),
      stableEntries: createUsageHistory(3),
      loaded: true,
    });

    render(<Models />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getAllByTestId('token-usage-entry')).toHaveLength(3);
  });

  it('refreshes token usage when the refresh button is clicked', async () => {
    useTokenUsageStore.setState({
      status: 'done',
      entries: createUsageHistory(10),
      stableEntries: createUsageHistory(10),
      loaded: true,
    });

    render(<Models />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(hostApiFetchMock).toHaveBeenCalledTimes(1);

    hostApiFetchMock.mockResolvedValueOnce(createUsageHistory(12));

    await act(async () => {
      screen.getByTestId('token-usage-refresh').click();
      await Promise.resolve();
    });

    expect(hostApiFetchMock).toHaveBeenCalledTimes(2);
    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/usage/recent-token-history');
  });

  it('keeps the current usage page after manual refresh', async () => {
    useTokenUsageStore.setState({
      status: 'done',
      entries: createUsageHistory(10),
      stableEntries: createUsageHistory(10),
      loaded: true,
    });

    render(<Models />);

    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      screen.getByRole('button', { name: 'dashboard:recentTokenHistory.next' }).click();
      await Promise.resolve();
    });

    expect(screen.getByText('session-6')).toBeInTheDocument();

    hostApiFetchMock.mockResolvedValueOnce(createUsageHistory(10));

    await act(async () => {
      screen.getByTestId('token-usage-refresh').click();
      await Promise.resolve();
    });

    expect(screen.getByText('session-6')).toBeInTheDocument();
  });
});
