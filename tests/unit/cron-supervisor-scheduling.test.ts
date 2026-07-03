import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { previousScheduleOccurrenceMs } from '@electron/gateway/cron-schedule';

const testOpenClawConfigDir = join(tmpdir(), 'lyclaw-tests', 'cron-supervisor-scheduling');
const TZ = 'Asia/Shanghai';

vi.mock('../../electron/utils/paths', () => ({
  getOpenClawConfigDir: () => testOpenClawConfigDir,
}));

vi.mock('electron', () => ({
  powerMonitor: { on: vi.fn() },
}));

/** Build an absolute timestamp from Shanghai wall-clock (UTC+8, no DST). */
function shanghai(year: number, month: number, day: number, hour: number, minute: number): number {
  return Date.UTC(year, month - 1, day, hour - 8, minute, 0);
}

function writeSidecar(createdAtMs: number) {
  writeFileSync(
    join(testOpenClawConfigDir, 'cron', '.lyclaw-cron-supervisor.json'),
    JSON.stringify({
      managed: { 'job-daily': { enabled: true, createdAtMs } },
      handled: {},
      scheduledHandled: {},
      retried: {},
    }),
  );
}

function buildInAppJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-daily',
    agentId: 'main',
    name: 'Daily task',
    enabled: false,
    sessionTarget: 'isolated',
    payload: { kind: 'agentTurn', message: 'Run daily' },
    delivery: { mode: 'none' },
    schedule: { kind: 'cron', expr: '30 9 * * *', tz: TZ },
    state: {},
    ...overrides,
  };
}

function buildGateway(chatSend: ReturnType<typeof vi.fn>, jobOverrides: Record<string, unknown> = {}) {
  const rpc = vi.fn(async (method: string) => {
    if (method === 'cron.list') {
      return { jobs: [buildInAppJob(jobOverrides)] };
    }
    if (method === 'chat.send') {
      return chatSend();
    }
    throw new Error(`unexpected rpc ${method}`);
  });

  return {
    getStatus: () => ({ state: 'running', warmupStatus: 'idle' as const }),
    rpc,
  };
}

describe('cron supervisor in-app scheduling', () => {
  beforeEach(() => {
    rmSync(testOpenClawConfigDir, { recursive: true, force: true });
    mkdirSync(join(testOpenClawConfigDir, 'cron', 'runs'), { recursive: true });
    vi.useFakeTimers();
    vi.resetModules();
  });

  afterEach(async () => {
    const { stopCronSupervisor } = await import('../../electron/gateway/cron-supervisor');
    stopCronSupervisor();
    vi.useRealTimers();
  });

  it('does not fire before the first scheduled occurrence after creation', async () => {
    const createdAtMs = shanghai(2026, 7, 3, 8, 0);
    vi.setSystemTime(shanghai(2026, 7, 3, 8, 5));
    writeSidecar(createdAtMs);

    const chatSend = vi.fn().mockResolvedValue({ runId: 'run-1' });
    const {
      bindCronSupervisorGateway,
      runCronSupervisorPass,
    } = await import('../../electron/gateway/cron-supervisor');
    bindCronSupervisorGateway(buildGateway(chatSend, { createdAtMs }));
    await runCronSupervisorPass('test-before-due');

    expect(chatSend).not.toHaveBeenCalled();
  });

  it('fires once at the scheduled time and not again via catch-up', async () => {
    const createdAtMs = shanghai(2026, 7, 3, 8, 0);
    const dueAtMs = shanghai(2026, 7, 3, 9, 30);
    const schedule = { kind: 'cron' as const, expr: '30 9 * * *', tz: TZ };

    expect(previousScheduleOccurrenceMs(schedule, dueAtMs + 60_000)).toBe(dueAtMs);

    vi.setSystemTime(dueAtMs + 60_000);
    writeSidecar(createdAtMs);

    const chatSend = vi.fn().mockResolvedValue({ runId: 'run-1' });
    const {
      bindCronSupervisorGateway,
      runCronSupervisorPass,
    } = await import('../../electron/gateway/cron-supervisor');
    bindCronSupervisorGateway(buildGateway(chatSend, { createdAtMs }));

    await runCronSupervisorPass('test-at-due');
    expect(chatSend).toHaveBeenCalledTimes(1);

    vi.setSystemTime(dueAtMs + 3 * 60_000);
    await runCronSupervisorPass('test-after-catchup-window');
    expect(chatSend).toHaveBeenCalledTimes(1);

    const sidecar = JSON.parse(
      readFileSync(join(testOpenClawConfigDir, 'cron', '.lyclaw-cron-supervisor.json'), 'utf8'),
    );
    expect(sidecar.scheduledHandled['job-daily']).toBe(dueAtMs);
    expect(sidecar.handled['job-daily']).toBe(dueAtMs);
    expect(existsSync(join(testOpenClawConfigDir, 'cron', 'runs', 'job-daily.jsonl'))).toBe(true);
  });

  it('uses sidecar createdAtMs when Gateway omits it and skips pre-creation occurrences', async () => {
    const createdAtMs = shanghai(2026, 7, 3, 8, 0);
    vi.setSystemTime(shanghai(2026, 7, 3, 8, 10));
    writeSidecar(createdAtMs);

    const chatSend = vi.fn().mockResolvedValue({ runId: 'run-1' });
    const {
      bindCronSupervisorGateway,
      runCronSupervisorPass,
    } = await import('../../electron/gateway/cron-supervisor');
    bindCronSupervisorGateway(buildGateway(chatSend));
    await runCronSupervisorPass('test-backfill');

    expect(chatSend).not.toHaveBeenCalled();
  });
});
