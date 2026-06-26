import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolRunRegistry, type ToolRunTerminalEvent } from '../../electron/runtime/tool-run-registry';

describe('ToolRunRegistry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('cleans up a running process when hard timeout fires', async () => {
    const cleanup = vi.fn(async () => ({ ok: true }));
    const terminal: ToolRunTerminalEvent[] = [];
    const registry = new ToolRunRegistry({
      hardTimeoutMs: 1000,
      idleTimeoutMs: 5000,
      ttlMs: 10000,
      cleanupToolRun: cleanup,
      onTerminal: (event) => terminal.push(event),
    });

    registry.registerRunningTool({
      sessionKey: 'agent:main:main',
      runId: 'run-1',
      toolCallId: 'call-1',
      toolName: 'exec',
      handle: { kind: 'process', id: 'vivid-tidepool', pid: 30032 },
    });

    await vi.advanceTimersByTimeAsync(1000);

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(cleanup.mock.calls[0][0]).toMatchObject({
      sessionKey: 'agent:main:main',
      runId: 'run-1',
      toolCallId: 'call-1',
      handle: { kind: 'process', id: 'vivid-tidepool', pid: 30032 },
    });
    expect(terminal).toHaveLength(1);
    expect(terminal[0].record).toMatchObject({
      status: 'timeout',
      terminalReason: 'hard-timeout',
      cleanup: { status: 'succeeded' },
    });
  });

  it('marks kill_failed when cleanup fails', async () => {
    const cleanup = vi.fn(async () => ({ ok: false, error: 'process refused to die' }));
    const terminal: ToolRunTerminalEvent[] = [];
    const registry = new ToolRunRegistry({
      hardTimeoutMs: 1000,
      idleTimeoutMs: 5000,
      ttlMs: 10000,
      cleanupToolRun: cleanup,
      onTerminal: (event) => terminal.push(event),
    });

    registry.registerRunningTool({
      sessionKey: 'agent:main:main',
      runId: 'run-1',
      toolCallId: 'call-1',
      toolName: 'exec',
      handle: { kind: 'process', id: 'stubborn-process', pid: 30100 },
    });

    await vi.advanceTimersByTimeAsync(1000);

    expect(terminal[0].record).toMatchObject({
      status: 'kill_failed',
      terminalReason: 'kill-failed',
      cleanup: {
        status: 'failed',
        error: 'process refused to die',
      },
    });
  });
  it('refreshes idle timeout when progress is marked', async () => {
    const cleanup = vi.fn(async () => ({ ok: true }));
    const terminal: ToolRunTerminalEvent[] = [];
    const registry = new ToolRunRegistry({
      hardTimeoutMs: 10000,
      idleTimeoutMs: 1000,
      ttlMs: 20000,
      cleanupToolRun: cleanup,
      onTerminal: (event) => terminal.push(event),
    });

    const record = registry.registerRunningTool({
      sessionKey: 'agent:main:main',
      runId: 'run-1',
      toolCallId: 'call-1',
      toolName: 'exec',
      handle: { kind: 'process', id: 'progressing-process', pid: 30200 },
    });

    await vi.advanceTimersByTimeAsync(900);
    registry.markProgress(record.toolRunId, { message: 'still working' });
    await vi.advanceTimersByTimeAsync(900);

    expect(cleanup).not.toHaveBeenCalled();
    expect(terminal).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(101);
    expect(terminal[0].record).toMatchObject({
      status: 'timeout',
      terminalReason: 'idle-timeout',
    });
  });

  it('cancels a running process and cleans up the handle', async () => {
    const cleanup = vi.fn(async () => ({ ok: true }));
    const terminal: ToolRunTerminalEvent[] = [];
    const registry = new ToolRunRegistry({
      hardTimeoutMs: 10000,
      idleTimeoutMs: 10000,
      ttlMs: 20000,
      cleanupToolRun: cleanup,
      onTerminal: (event) => terminal.push(event),
    });

    const record = registry.registerRunningTool({
      sessionKey: 'agent:main:main',
      runId: 'run-1',
      toolCallId: 'call-1',
      toolName: 'exec',
      handle: { kind: 'process', id: 'cancel-me', pid: 30300 },
    });

    const cancelled = await registry.cancelToolRun(record.toolRunId, 'user-cancelled');

    expect(cancelled).toMatchObject({
      status: 'cancelled',
      terminalReason: 'user-cancelled',
      cleanup: { status: 'succeeded' },
    });
    expect(cleanup).toHaveBeenCalledWith(expect.objectContaining({ handle: { kind: 'process', id: 'cancel-me', pid: 30300 } }), 'user-cancelled');
    expect(terminal).toHaveLength(1);
  });

  it('cleans up a completed process handle without marking it failed', async () => {
    const cleanup = vi.fn(async () => ({ ok: true }));
    const registry = new ToolRunRegistry({
      hardTimeoutMs: 10000,
      idleTimeoutMs: 10000,
      ttlMs: 20000,
      cleanupToolRun: cleanup,
    });

    const record = registry.registerRunningTool({
      sessionKey: 'agent:main:main',
      runId: 'run-1',
      toolCallId: 'call-1',
      toolName: 'exec',
      handle: { kind: 'process', id: 'done-process', pid: 30400 },
    });

    const completed = await registry.cleanupCompletedToolRun(record.toolRunId, 'completed');

    expect(completed).toMatchObject({
      status: 'completed',
      terminalReason: 'completed',
      cleanup: { status: 'succeeded' },
    });
    expect(cleanup).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }), 'completed');
  });
  it('fails and cleans up newly tracked tools when active quotas are exceeded', async () => {
    const cleanup = vi.fn(async () => ({ ok: true }));
    const terminal: ToolRunTerminalEvent[] = [];
    const registry = new ToolRunRegistry({
      hardTimeoutMs: 10000,
      idleTimeoutMs: 10000,
      ttlMs: 20000,
      maxActivePerSession: 1,
      maxActiveGlobal: 10,
      cleanupToolRun: cleanup,
      onTerminal: (event) => terminal.push(event),
    });

    registry.registerRunningTool({
      sessionKey: 'agent:main:main',
      runId: 'run-1',
      toolCallId: 'call-1',
      toolName: 'exec',
      handle: { kind: 'process', id: 'first-process', pid: 30500 },
    });
    registry.registerRunningTool({
      sessionKey: 'agent:main:main',
      runId: 'run-2',
      toolCallId: 'call-2',
      toolName: 'exec',
      handle: { kind: 'process', id: 'second-process', pid: 30501 },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(cleanup).toHaveBeenCalledWith(
      expect.objectContaining({ handle: { kind: 'process', id: 'second-process', pid: 30501 } }),
      'quota-exceeded',
    );
    expect(terminal[0].record).toMatchObject({
      status: 'failed',
      terminalReason: 'quota-exceeded',
      cleanup: { status: 'succeeded' },
    });
    expect(registry.getQuotaSnapshot()).toMatchObject({
      maxActivePerSession: 1,
      activeGlobal: 1,
      activeBySession: { 'agent:main:main': 1 },
    });
  });
});
