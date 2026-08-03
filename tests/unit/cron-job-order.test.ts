import { describe, expect, it } from 'vitest';
import {
  applyCronJobOrder,
  mergeCronJobOrder,
  removeCronJobIdFromOrder,
  reorderCronJobIds,
} from '../../src/lib/cron-job-order';
import type { CronJob } from '../../src/types/cron';

function createJob(id: string, name: string): CronJob {
  return {
    id,
    name,
    message: 'hello',
    schedule: '0 9 * * *',
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    agentId: 'main',
  };
}

describe('cron job order helpers', () => {
  const jobs = [
    createJob('job-a', 'A'),
    createJob('job-b', 'B'),
    createJob('job-c', 'C'),
  ];

  it('applies saved order and appends unknown jobs', () => {
    expect(applyCronJobOrder(jobs, ['job-c', 'job-a']).map((job) => job.id)).toEqual([
      'job-c',
      'job-a',
      'job-b',
    ]);
  });

  it('merges new jobs to the end without disturbing existing order', () => {
    expect(mergeCronJobOrder(['job-b', 'job-a'], jobs)).toEqual(['job-b', 'job-a', 'job-c']);
  });

  it('swaps two ids in place without shifting others', () => {
    expect(reorderCronJobIds(['job-a', 'job-b', 'job-c'], 'job-c', 'job-a')).toEqual([
      'job-c',
      'job-b',
      'job-a',
    ]);
    expect(reorderCronJobIds(['job-a', 'job-b', 'job-c'], 'job-a', 'job-b')).toEqual([
      'job-b',
      'job-a',
      'job-c',
    ]);
  });

  it('swaps distant ids in a longer list', () => {
    expect(reorderCronJobIds(
      ['job-a', 'job-b', 'job-c', 'job-d', 'job-e'],
      'job-e',
      'job-a',
    )).toEqual([
      'job-e',
      'job-b',
      'job-c',
      'job-d',
      'job-a',
    ]);
  });

  it('removes deleted job ids from saved order', () => {
    expect(removeCronJobIdFromOrder(['job-a', 'job-b', 'job-c'], 'job-b')).toEqual([
      'job-a',
      'job-c',
    ]);
  });
});
