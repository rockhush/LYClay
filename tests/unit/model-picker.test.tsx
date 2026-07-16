import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ModelPicker } from '@/components/workspace/ModelPicker';
import type { ProviderAccount, ProviderWithKeyInfo, ProviderVendorInfo } from '@/lib/providers';

const hostApiFetchMock = vi.fn();
const setCurrentSessionModelMock = vi.fn();

const { agentsState, chatState, providersState, digitalEmployeesState } = vi.hoisted(() => ({
  agentsState: {
    agents: [] as Array<Record<string, unknown>>,
    defaultModelRef: null as string | null,
  },
  chatState: {
    activeRunId: null as string | null,
    currentAgentId: 'employee-agent',
    currentSessionKey: 'agent:employee-agent:main',
    runAborted: false,
    sending: false,
    sessions: [] as Array<Record<string, unknown>>,
  },
  providersState: {
    accounts: [] as ProviderAccount[],
    statuses: [] as ProviderWithKeyInfo[],
    vendors: [] as ProviderVendorInfo[],
    defaultAccountId: '',
  },
  digitalEmployeesState: {
    employees: [] as Array<Record<string, unknown>>,
  },
}));

vi.mock('@/stores/agents', () => ({
  useAgentsStore: (selector: (state: typeof agentsState) => unknown) => selector(agentsState),
}));

vi.mock('@/stores/digital-employees', () => ({
  useDigitalEmployeesStore: (selector: (state: typeof digitalEmployeesState) => unknown) => selector(digitalEmployeesState),
}));

vi.mock('@/stores/chat', () => ({
  useChatStore: (selector: (state: typeof chatState & {
    setCurrentSessionModel: typeof setCurrentSessionModelMock;
  }) => unknown) => selector({
    ...chatState,
    setCurrentSessionModel: setCurrentSessionModelMock,
  }),
}));

vi.mock('@/stores/providers', () => ({
  useProviderStore: () => providersState,
}));

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

function sub2ApiAccount(overrides: Partial<ProviderAccount> = {}): ProviderAccount {
  return {
    id: 'sub2api-global-b3fe6919-apiKey-10',
    vendorId: 'custom',
    label: 'LY-SUB2API',
    authMode: 'api_key',
    baseUrl: 'https://global.example.com/v1',
    apiProtocol: 'openai-completions',
    model: 'deepseek-v4-flash',
    fallbackModels: ['deepseek-v4-flash'],
    runtimeModels: [{ id: 'deepseek-v4-flash', name: 'LY-deepseek-v4-flash' }],
    enabled: true,
    isDefault: true,
    metadata: { managedBy: 'sub2api', scope: 'global' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('ModelPicker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentsState.agents = [
      {
        id: 'employee-agent',
        name: 'Employee Agent',
        isDigitalEmployee: true,
        modelRef: 'custom-sub2g43efa837/deepseek-v4-flash',
      },
    ];
    agentsState.defaultModelRef = null;
    chatState.activeRunId = null;
    chatState.currentAgentId = 'employee-agent';
    chatState.currentSessionKey = 'agent:employee-agent:main';
    chatState.runAborted = false;
    chatState.sending = false;
    chatState.sessions = [
      {
        key: 'agent:employee-agent:main',
        model: 'custom-sub2g43efa837/deepseek-v4-flash',
      },
    ];
    providersState.accounts = [sub2ApiAccount()];
    providersState.statuses = [
      {
        id: 'sub2api-global-b3fe6919-apiKey-10',
        name: 'LY-SUB2API',
        type: 'custom',
        model: 'deepseek-v4-flash',
        fallbackModels: ['deepseek-v4-flash'],
        enabled: true,
        hasKey: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ];
    providersState.vendors = [{ id: 'custom', name: 'Custom', modelIdPlaceholder: 'model-id' }];
    providersState.defaultAccountId = 'sub2api-global-b3fe6919-apiKey-10';
    hostApiFetchMock.mockResolvedValue({
      success: true,
      modelScope: {
        provider: {
          providerId: 'sub2api-employee-document-apiKey-11',
          protocol: 'openai-completions',
          baseUrl: 'https://employee.example.com/v1',
        },
        models: [{ id: 'deepseek-v4-flash', name: 'LY-deepseek-v4-flash' }],
        defaultModel: 'deepseek-v4-flash',
        lastSuccessAt: '2026-01-01T00:00:00.000Z',
      },
    });
    setCurrentSessionModelMock.mockResolvedValue(undefined);
  });

  it('only marks the matching provider ref selected when duplicate model ids exist', async () => {
    render(<ModelPicker />);

    fireEvent.click(screen.getByTitle('composer.switchModel'));

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /LY-deepseek-v4-flash/ })).toHaveLength(3);
    });

    const options = screen.getAllByRole('button', { name: /^LY-deepseek-v4-flash deepseek-v4-flash$/ });
    expect(options).toHaveLength(2);
    expect(options.map((option) => option.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
  });

  it('falls back to one selected option when the saved model ref uses a stale provider key', async () => {
    chatState.sessions = [
      {
        key: 'agent:employee-agent:main',
        model: 'ly-deepseek/deepseek-v4-flash',
      },
    ];

    render(<ModelPicker />);

    fireEvent.click(screen.getByTitle('composer.switchModel'));

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /LY-deepseek-v4-flash/ })).toHaveLength(3);
    });

    const options = screen.getAllByRole('button', { name: /^LY-deepseek-v4-flash deepseek-v4-flash$/ });
    expect(options).toHaveLength(2);
    expect(options.map((option) => option.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
  });

  it('keeps the clicked duplicate option selected while the session snapshot catches up', async () => {
    render(<ModelPicker />);

    fireEvent.click(screen.getByTitle('composer.switchModel'));

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /LY-deepseek-v4-flash/ })).toHaveLength(3);
    });

    let options = screen.getAllByRole('button', { name: /^LY-deepseek-v4-flash deepseek-v4-flash$/ });
    expect(options.map((option) => option.getAttribute('aria-pressed'))).toEqual(['false', 'true']);

    fireEvent.click(options[0]);

    await waitFor(() => {
      expect(setCurrentSessionModelMock).toHaveBeenCalledWith('custom-sub2e5228ac09/deepseek-v4-flash');
    });

    fireEvent.click(screen.getByTitle('composer.switchModel'));

    options = screen.getAllByRole('button', { name: /^LY-deepseek-v4-flash deepseek-v4-flash$/ });
    expect(options.map((option) => option.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
  });
});
