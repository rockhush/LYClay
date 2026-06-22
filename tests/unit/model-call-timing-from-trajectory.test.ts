import { describe, expect, it } from 'vitest';
import { parseTrajectoryModelCallTimings } from '@electron/utils/model-call-timing-from-trajectory';

describe('parseTrajectoryModelCallTimings', () => {
  it('computes duration between prompt.submitted and model.completed', () => {
    const trajectory = [
      {
        type: 'prompt.submitted',
        runId: 'run-1',
        ts: '2026-06-18T01:24:48.324Z',
        modelId: 'auto',
        provider: 'ly-auto',
      },
      {
        type: 'model.completed',
        runId: 'run-1',
        ts: '2026-06-18T01:26:19.624Z',
        modelId: 'auto',
        provider: 'ly-auto',
        data: { usage: { input: 1, output: 2, total: 3 } },
      },
    ].map((entry) => JSON.stringify(entry)).join('\n');

    const timings = parseTrajectoryModelCallTimings(trajectory);
    expect(timings).toHaveLength(1);
    expect(timings[0]?.runId).toBe('run-1');
    expect(timings[0]?.durationMs).toBe(91_300);
    expect(timings[0]?.model).toBe('auto');
    expect(timings[0]?.provider).toBe('ly-auto');
  });
});
