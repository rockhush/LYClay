import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { workspacesState } = vi.hoisted(() => ({
  workspacesState: {
    currentWorkspaceId: null as string | null,
    currentWorkspacePath: null as string | null,
    setCurrentWorkspace: vi.fn((workspaceId: string | null) => {
      workspacesState.currentWorkspaceId = workspaceId;
      workspacesState.currentWorkspacePath = workspaceId ? '/tmp/workspace' : null;
    }),
  },
}));

vi.mock('@/stores/gateway', () => ({
  useGatewayStore: {
    getState: () => ({
      rpc: vi.fn(),
      status: { gatewayReady: false },
    }),
  },
}));

vi.mock('@/stores/agents', () => ({
  useAgentsStore: {
    getState: () => ({ agents: [] }),
  },
}));

vi.mock('@/stores/workspaces', () => ({
  useWorkspacesStore: {
    getState: () => workspacesState,
  },
}));

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: vi.fn(),
}));

vi.mock('@/lib/ui-state-persistence', () => ({
  hydrateUiStateFromDisk: vi.fn().mockResolvedValue(undefined),
  persistUiStateSoon: vi.fn(),
}));

describe('chat newSession workspace', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-08T12:00:00Z'));
    window.localStorage.clear();
    workspacesState.currentWorkspaceId = 'workspace-test2';
    workspacesState.currentWorkspacePath = '/tmp/test2';
    workspacesState.setCurrentWorkspace.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('clears workspace binding and picker when creating a new session', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1717848000000);
    const { useChatStore } = await import('@/stores/chat');

    useChatStore.setState({
      currentSessionKey: 'agent:main:session-old',
      sessions: [{ key: 'agent:main:session-old', displayName: 'Old' }],
      sessionWorkspaceIds: { 'agent:main:session-old': 'workspace-test2' },
      messages: [{ role: 'user', content: 'hello' }],
    });

    useChatStore.getState().newSession();

    const next = useChatStore.getState();
    expect(next.currentSessionKey).toBe('agent:main:session-1717848000000');
    expect(next.sessionWorkspaceIds['agent:main:session-1717848000000']).toBeUndefined();
    expect(workspacesState.setCurrentWorkspace).toHaveBeenCalledWith(null);
    expect(workspacesState.currentWorkspaceId).toBeNull();

    nowSpy.mockRestore();
  });
});
