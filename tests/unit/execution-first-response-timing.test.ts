import { beforeEach, describe, expect, it, vi } from 'vitest';

const hostApiFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/host-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/host-api')>();
  return {
    ...actual,
    hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
  };
});

import {
  beginExecutionTurn,
  finalizeExecutionTurn,
  noteExecutionFirstResponseFromMessage,
} from '@/lib/execution-turn-tracker';

describe('execution first response timing', () => {
  const sessionKey = 'agent:main:session-test';

  beforeEach(() => {
    hostApiFetchMock.mockReset();
    hostApiFetchMock.mockResolvedValue({ success: true });
  });

  it('uses transcript thinking timestamp instead of a later delta-only mark', async () => {
    const sendMs = Date.parse('2026-07-27T15:13:58');
    beginExecutionTurn({
      sessionKey,
      agentId: 'main',
      modelId: 'auto',
      messages: [{ role: 'user', content: 'hello', id: 'u1', timestamp: sendMs }],
      startedAtMs: sendMs,
    });

    noteExecutionFirstResponseFromMessage({
      role: 'assistant',
      timestamp: sendMs + 3_000,
      content: [{ type: 'thinking', thinking: 'Let me check.' }],
    });

    finalizeExecutionTurn({
      status: 'success',
      messages: [
        { role: 'user', content: 'hello', id: 'u1', timestamp: sendMs },
        {
          role: 'assistant',
          timestamp: sendMs + 35_000,
          content: [{ type: 'text', text: 'answer' }],
        },
      ],
      lastUserMessageAt: sendMs,
    });

    await Promise.resolve();

    expect(hostApiFetchMock).toHaveBeenCalled();
    const body = JSON.parse(String(hostApiFetchMock.mock.calls[0]?.[1]?.body)) as {
      first_response_ms?: number;
    };
    expect(body.first_response_ms).toBe(3_000);
  });
});
