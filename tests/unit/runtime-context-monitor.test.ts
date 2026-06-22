import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatState, RawMessage } from '@/stores/chat/types';

const hostApiFetchMock = vi.hoisted(() => vi.fn());
const gatewayRpcMock = vi.hoisted(() => vi.fn());
const agentsState = vi.hoisted(() => ({
  agents: [{ id: 'main', modelRef: 'ly-auto/auto' }],
  defaultModelRef: 'ly-auto/auto',
}));

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: hostApiFetchMock,
}));

vi.mock('@/stores/agents', () => ({
  useAgentsStore: {
    getState: () => agentsState,
  },
}));

vi.mock('@/stores/gateway', () => ({
  useGatewayStore: {
    getState: () => ({
      rpc: gatewayRpcMock,
    }),
  },
}));

function makeMessages(count: number, contentLength: number): RawMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: '测'.repeat(contentLength),
    id: `msg-${index}`,
  }));
}

describe('maybeCompressRuntimeContext', () => {
  let state: ChatState;

  beforeEach(() => {
    vi.resetModules();
    hostApiFetchMock.mockReset();
    gatewayRpcMock.mockReset();
    hostApiFetchMock.mockImplementation((url: string) => {
      if (String(url).includes('token-usage')) return Promise.resolve({ jsonlTokens: 80000 });
      return Promise.resolve({ contextWindow: 128000 });
    });
    state = {
      currentSessionKey: 'agent:main:main',
      currentAgentId: 'main',
      messages: makeMessages(12, 7000),
      sending: true,
      activeRunId: 'run-1',
      sessionCompressionState: {},
      contextCompressionStatus: null,
      loadHistory: vi.fn().mockResolvedValue(undefined),
    } as unknown as ChatState;
  });

  function set(patch: Partial<ChatState> | ((current: ChatState) => Partial<ChatState>)) {
    const next = typeof patch === 'function' ? patch(state) : patch;
    state = { ...state, ...next };
  }

  function get() {
    return state;
  }

  it('skips compaction during active run (avoids interrupting agent)', async () => {
    const { maybeCompressRuntimeContext } = await import('@/stores/chat/runtime-context-monitor');

    // requireActiveRun: true + sending: true → skip, don't interrupt
    maybeCompressRuntimeContext(set, get, { runId: 'run-1', throttle: false });

    // Wait a tick to let async handler run
    await new Promise((r) => setTimeout(r, 200));

    // sessions.compact was NOT called (would interrupt the run)
    expect(gatewayRpcMock).not.toHaveBeenCalled();
    // Status was NOT changed (no warning spam)
    expect(state.contextCompressionStatus).toBeNull();
  });

  it('compacts when requireActiveRun is false (idle)', async () => {
    gatewayRpcMock.mockResolvedValue({ compacted: true, ok: true, tokensAfter: 25000 });
    state.sending = false;
    state.activeRunId = null;

    const { maybeCompressRuntimeContext } = await import('@/stores/chat/runtime-context-monitor');

    // requireActiveRun: false → idle, safe to compact
    maybeCompressRuntimeContext(set, get, { requireActiveRun: false, throttle: false });

    await vi.waitFor(() => {
      expect(state.contextCompressionStatus?.status).toBe('compressed');
    }, { timeout: 3000 });

    expect(gatewayRpcMock).toHaveBeenCalledWith(
      'sessions.compact',
      { key: 'agent:main:main' },
      120000,
    );
  });

  it('skips when gateway tokens are below threshold', async () => {
    hostApiFetchMock.mockImplementation((url: string) => {
      if (String(url).includes('token-usage')) return Promise.resolve({ jsonlTokens: 30000 });
      return Promise.resolve({ contextWindow: 128000 });
    });

    const { maybeCompressRuntimeContext } = await import('@/stores/chat/runtime-context-monitor');

    maybeCompressRuntimeContext(set, get, { runId: 'run-1', throttle: false });

    await vi.waitFor(() => {
      // inFlight cleared
    }, { timeout: 500 });

    expect(gatewayRpcMock).not.toHaveBeenCalled();
  });
});
