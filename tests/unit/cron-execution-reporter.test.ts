import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const testOpenClawConfigDir = join(tmpdir(), 'lyclaw-tests', 'cron-execution-reporter');
const recordExecutionMock = vi.fn(async () => {});
const getQueueSnapshotMock = vi.fn(async () => ({
  tokenConsume: [],
  skillDownload: [],
  skillInvoke: [],
  execution: [],
}));

vi.mock('@electron/utils/paths', () => ({
  getOpenClawConfigDir: () => testOpenClawConfigDir,
}));

vi.mock('../../electron/utils/reporting/index', () => ({
  recordExecution: (...args: unknown[]) => recordExecutionMock(...args),
}));

vi.mock('../../electron/utils/reporting/queue', () => ({
  getUsageReportQueueSnapshot: () => getQueueSnapshotMock(),
}));

import {
  clearCronExecutionPendingState,
  registerCronExecutionPending,
} from '@electron/utils/reporting/cron-execution-pending';
import { reportCronExecutionOnRunTerminal } from '@electron/utils/reporting/cron-execution-reporter';

const sessionKey = 'agent:main:scheduled-task:job-1:run-abc';
const agentId = 'main';
const runId = 'gateway-run-1';

function writeTranscript(lines: object[]): void {
  const sessionsDir = join(testOpenClawConfigDir, 'agents', agentId, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  const transcriptPath = join(sessionsDir, 'scheduled-task-job-1-run-abc.jsonl');
  writeFileSync(transcriptPath, lines.map((line) => JSON.stringify(line)).join('\n'), 'utf8');
  writeFileSync(join(sessionsDir, 'sessions.json'), JSON.stringify({
    [sessionKey]: {
      id: 'scheduled-task-job-1-run-abc',
      sessionFile: transcriptPath,
    },
  }), 'utf8');
}

describe('cron execution reporter', () => {
  beforeEach(() => {
    clearCronExecutionPendingState();
    recordExecutionMock.mockClear();
    getQueueSnapshotMock.mockReset();
    getQueueSnapshotMock.mockResolvedValue({
      tokenConsume: [],
      skillDownload: [],
      skillInvoke: [],
      execution: [],
    });
  });

  it('no-ops when runId was not registered by cron-supervisor', async () => {
    await reportCronExecutionOnRunTerminal({
      runId: 'unknown-run',
      sessionKey,
      state: 'final',
      acceptedAtMs: Date.now(),
    });
    expect(recordExecutionMock).not.toHaveBeenCalled();
  });

  it('normalizes bare auto model id with transcript provider', async () => {
    const userTs = 1_700_000_000_000;
    const assistantTs = userTs + 5_000;
    writeTranscript([
      {
        type: 'message',
        timestamp: new Date(userTs).toISOString(),
        message: {
          role: 'user',
          content: 'Run daily summary',
          timestamp: userTs / 1000,
        },
      },
      {
        type: 'message',
        timestamp: new Date(assistantTs).toISOString(),
        message: {
          role: 'assistant',
          content: 'Done.',
          timestamp: assistantTs / 1000,
          usage: { input: 10, output: 5, cacheRead: 0 },
          model: 'auto',
          provider: 'ly-auto',
        },
      },
    ]);

    registerCronExecutionPending({
      runId,
      sessionKey,
      agentId,
      registeredAtMs: userTs,
    });

    await reportCronExecutionOnRunTerminal({
      runId,
      sessionKey,
      state: 'final',
      acceptedAtMs: userTs + 100,
      firstDeltaAt: userTs + 800,
    });

    const record = recordExecutionMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(record.model_id).toBe('ly-auto/auto');
  });

  it('queues schedule execution with transcript-backed tokens on terminal final', async () => {
    const userTs = 1_700_000_000_000;
    const assistantTs = userTs + 5_000;
    writeTranscript([
      {
        type: 'message',
        timestamp: new Date(userTs).toISOString(),
        message: {
          role: 'user',
          content: 'Run daily summary',
          timestamp: userTs / 1000,
        },
      },
      {
        type: 'message',
        timestamp: new Date(assistantTs).toISOString(),
        message: {
          role: 'assistant',
          content: 'Done.',
          timestamp: assistantTs / 1000,
          usage: {
            input: 120,
            output: 45,
            cacheRead: 300,
          },
          model: 'claude-sonnet-4',
        },
      },
    ]);

    registerCronExecutionPending({
      runId,
      sessionKey,
      agentId,
      registeredAtMs: userTs,
    });

    await reportCronExecutionOnRunTerminal({
      runId,
      sessionKey,
      state: 'final',
      acceptedAtMs: userTs + 100,
      firstDeltaAt: userTs + 800,
    });

    expect(recordExecutionMock).toHaveBeenCalledTimes(1);
    const record = recordExecutionMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(record.entry_source).toBe('schedule');
    expect(record.conversation_id).toBe(sessionKey);
    expect(record.turn_index).toBe(1);
    expect(record.agent_id).toBe(agentId);
    expect(record.status).toBe('success');
    expect(record.input_tokens).toBe(120);
    expect(record.output_tokens).toBe(45);
    expect(record.cache_read_tokens).toBe(300);
    expect(record.model_id).toBe('claude-sonnet-4');
    // first_response_ms is measured from the user message timestamp (startedAtMs), not chat.send acceptedAt.
    expect(record.first_response_ms).toBe(800);
  });

  it('skips duplicate schedule turn already present in queue', async () => {
    getQueueSnapshotMock.mockResolvedValue({
      tokenConsume: [],
      skillDownload: [],
      skillInvoke: [],
      execution: [{
        execution_id: 'existing',
        conversation_id: sessionKey,
        turn_index: 1,
        entry_source: 'schedule',
        work_no: 'u1',
        agent_type: 'normal',
        agent_id: agentId,
        model_id: 'auto',
        status: 'success',
      }],
    });

    registerCronExecutionPending({ runId, sessionKey, agentId, registeredAtMs: Date.now() });

    await reportCronExecutionOnRunTerminal({
      runId,
      sessionKey,
      state: 'final',
      acceptedAtMs: Date.now(),
    });

    expect(recordExecutionMock).not.toHaveBeenCalled();
  });

  it('reports failed status for terminal error state', async () => {
    registerCronExecutionPending({ runId, sessionKey, agentId, registeredAtMs: Date.now() });

    await reportCronExecutionOnRunTerminal({
      runId,
      sessionKey,
      state: 'error',
      acceptedAtMs: Date.now(),
      terminalMessage: { content: 'Gateway websocket disconnected' },
    });

    expect(recordExecutionMock).toHaveBeenCalledTimes(1);
    const record = recordExecutionMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(record.status).toBe('failed');
    expect(record.error_stage).toBe('gateway');
    expect(record.error_message).toContain('Gateway websocket disconnected');
  });
});
