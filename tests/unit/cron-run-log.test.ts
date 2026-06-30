import { describe, expect, it } from 'vitest';
import {
  latestFinishedCronRun,
  resolveEffectiveLastRunAtMs,
  resolveInAppCronLastRun,
} from '@electron/gateway/cron-run-log';

describe('cron run log helpers', () => {
  const inAppJob = {
    sessionTarget: 'isolated',
    payload: { kind: 'agentTurn' },
    delivery: { mode: 'none' },
    state: { lastRunAtMs: 1_000, lastStatus: 'ok' },
  };

  it('prefers newer finished run log entries for in-app jobs', () => {
    const runs = [
      { action: 'finished', status: 'ok', runAtMs: 5_000 },
      { action: 'finished', status: 'error', error: 'timeout', runAtMs: 9_000 },
    ];

    expect(resolveEffectiveLastRunAtMs({ ...inAppJob, id: 'job-a' }, runs)).toBe(9_000);
    expect(resolveInAppCronLastRun(inAppJob, runs)).toEqual({
      time: new Date(9_000).toISOString(),
      success: false,
      error: 'timeout',
      duration: undefined,
    });
  });

  it('keeps gateway state for external delivery jobs', () => {
    const externalJob = {
      sessionTarget: 'isolated',
      payload: { kind: 'agentTurn' },
      delivery: { mode: 'announce', channel: 'dingtalk', to: 'cid' },
      state: { lastRunAtMs: 8_000, lastStatus: 'ok' },
    };
    const runs = [{ action: 'finished', status: 'ok', runAtMs: 12_000 }];

    expect(resolveEffectiveLastRunAtMs({ ...externalJob, id: 'job-b' }, runs)).toBe(8_000);
    expect(resolveInAppCronLastRun(externalJob, runs)?.time).toBe(new Date(8_000).toISOString());
  });

  it('picks the latest finished entry from a run log', () => {
    const latest = latestFinishedCronRun([
      { action: 'finished', status: 'ok', ts: 2_000 },
      { action: 'finished', status: 'error', runAtMs: 4_000, error: 'failed' },
      { action: 'started', status: 'running', runAtMs: 6_000 },
    ]);

    expect(latest).toEqual({
      runAtMs: 4_000,
      success: false,
      error: 'failed',
      durationMs: undefined,
    });
  });
});
