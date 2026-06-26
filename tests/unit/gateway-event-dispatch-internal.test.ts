import { describe, expect, it, vi } from 'vitest';
import { dispatchProtocolEvent } from '../../electron/gateway/event-dispatch';

describe('Gateway event dispatch internal filtering', () => {
  it('does not forward heartbeat chat events to the renderer', () => {
    const emitter = { emit: vi.fn(() => true) };

    dispatchProtocolEvent(emitter, 'chat', {
      state: 'final',
      runId: 'heartbeat-run',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'HEARTBEAT_OK' }],
      },
    });

    expect(emitter.emit).not.toHaveBeenCalledWith('chat:message', expect.anything());
  });

  it('still forwards normal chat events', () => {
    const emitter = { emit: vi.fn(() => true) };

    dispatchProtocolEvent(emitter, 'chat', {
      state: 'final',
      runId: 'user-run',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
      },
    });

    expect(emitter.emit).toHaveBeenCalledWith('chat:message', {
      message: expect.objectContaining({ runId: 'user-run' }),
    });
  });
});
