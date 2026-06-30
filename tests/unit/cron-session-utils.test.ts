import { describe, expect, it } from 'vitest';
import {
  formatCronSessionDisplayLabel,
  isCronSessionKey,
  parseCronSessionKey,
} from '../../src/stores/chat/cron-session-utils';

describe('parseCronSessionKey', () => {
  it('parses cron job session keys', () => {
    expect(parseCronSessionKey('agent:main:cron:job-123')).toEqual({
      agentId: 'main',
      jobId: 'job-123',
    });
  });

  it('parses cron run session keys', () => {
    expect(parseCronSessionKey('agent:main:cron:job-123:run:run-456')).toEqual({
      agentId: 'main',
      jobId: 'job-123',
      runSessionId: 'run-456',
    });
  });

  it('parses scheduled-task run session keys', () => {
    expect(parseCronSessionKey('agent:main:scheduled-task:job-123:run-456')).toEqual({
      agentId: 'main',
      jobId: 'job-123',
      runSessionId: 'run-456',
    });
  });
});

describe('isCronSessionKey', () => {
  it('returns true for cron session keys', () => {
    expect(isCronSessionKey('agent:main:cron:46f41448-0d2f-49bd-a6a2-e1245576a17d')).toBe(true);
  });

  it('returns true for scheduled-task session keys', () => {
    expect(isCronSessionKey('agent:main:scheduled-task:job-123:run-456')).toBe(true);
  });

  it('returns false for normal chat session keys', () => {
    expect(isCronSessionKey('agent:main:thread:abc')).toBe(false);
  });
});

describe('formatCronSessionDisplayLabel', () => {
  it('replaces bracket cron ids with job name', () => {
    expect(
      formatCronSessionDisplayLabel('[cron:46f41448-0d2f-49bd-a6a2-e1245576a17d]', {
        jobName: '看球了',
      }),
    ).toBe('Cron: 看球了');
  });

  it('uses fallback when label is only a cron id', () => {
    expect(
      formatCronSessionDisplayLabel('[cron:46f41448-0d2f-49bd-a6a2-e1245576a17d]', {
        fallback: '定时任务',
      }),
    ).toBe('定时任务');
  });

  it('preserves friendly Cron labels', () => {
    expect(formatCronSessionDisplayLabel('Cron: 看球了')).toBe('Cron: 看球了');
  });

  it('strips embedded cron id prefixes', () => {
    expect(
      formatCronSessionDisplayLabel('[cron:abc] Cron: 看球了', { fallback: '定时任务' }),
    ).toBe('Cron: 看球了');
  });

  it('hides raw cron session keys', () => {
    expect(
      formatCronSessionDisplayLabel('agent:main:cron:46f41448-0d2f-49bd-a6a2-e1245576a17d', {
        jobName: '看球了',
        fallback: '定时任务',
      }),
    ).toBe('Cron: 看球了');
  });
});
