import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { mergeCronSessionHistory } from '../../src/stores/chat/cron-session-utils';

describe('mergeCronSessionHistory', () => {
  it('keeps aggregated history and appends newer latest-run messages', () => {
    const aggregated = [
      { role: 'user', content: 'day 1 prompt', timestamp: 1_000 },
      { role: 'assistant', content: 'day 1 answer', timestamp: 2_000 },
    ];
    const latest = [
      { role: 'user', content: 'day 2 prompt', timestamp: 86_400_000 },
      { role: 'assistant', content: 'day 2 answer', timestamp: 86_401_000 },
    ];

    expect(mergeCronSessionHistory(aggregated, latest)).toEqual([
      ...aggregated,
      ...latest,
    ]);
  });

  it('deduplicates overlapping latest-run messages', () => {
    const aggregated = [
      { role: 'assistant', content: 'same answer', timestamp: 2_000 },
    ];
    const latest = [
      { role: 'assistant', content: 'same answer', timestamp: 2_000 },
    ];

    expect(mergeCronSessionHistory(aggregated, latest)).toEqual(aggregated);
  });
});

describe('buildCronSessionHistoryMessages', () => {
  it('loads transcript for scheduled-task run session keys', async () => {
    const tempDir = join(tmpdir(), `cron-history-scheduled-${Date.now()}`);
    const sessionsDir = join(tempDir, 'agents', 'main', 'sessions');
    await mkdir(sessionsDir, { recursive: true });

    const runPath = join(sessionsDir, 'scheduled-run.jsonl');
    await writeFile(runPath, [
      JSON.stringify({
        type: 'message',
        timestamp: '2026-06-27T06:50:00.000Z',
        message: { role: 'user', content: 'Scheduled prompt', timestamp: 1_751_001_000 },
      }),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-06-27T06:50:10.000Z',
        message: { role: 'assistant', content: 'Scheduled answer', timestamp: 1_751_001_010 },
      }),
    ].join('\n'), 'utf8');

    const sessionKey = 'agent:main:scheduled-task:job-daily:scheduled-run';
    await writeFile(join(sessionsDir, 'sessions.json'), JSON.stringify({
      [sessionKey]: { sessionFile: 'scheduled-run.jsonl', updatedAt: 1_751_001_010_000 },
    }), 'utf8');

    const { buildCronSessionHistoryMessages: buildHistory, buildSessionFileIndex: buildIndex } =
      await import('@electron/gateway/cron-session-history');

    const filesBySessionKey = await buildIndex(join(sessionsDir, 'sessions.json'));
    const messages = await buildHistory({
      agentId: 'main',
      jobId: 'job-daily',
      sessionKey,
      runs: [
        {
          action: 'finished',
          status: 'ok',
          runAtMs: 1_751_001_010_000,
          sessionId: 'scheduled-run',
          sessionKey,
        },
      ],
      job: { name: 'Daily English', payload: { message: 'Send 10 words' } },
      sessionsDir,
      filesBySessionKey,
    });

    expect(
      messages
        .filter((message) => message.role === 'user' || message.role === 'assistant')
        .map((message) => message.content),
    ).toEqual(['Scheduled prompt', 'Scheduled answer']);
  });

  it('aggregates transcripts from multiple cron runs', async () => {
    const tempDir = join(tmpdir(), `cron-history-${Date.now()}`);
    const sessionsDir = join(tempDir, 'agents', 'main', 'sessions');
    await mkdir(sessionsDir, { recursive: true });

    const runOnePath = join(sessionsDir, 'run-one.jsonl');
    const runTwoPath = join(sessionsDir, 'run-two.jsonl');
    await writeFile(runOnePath, [
      JSON.stringify({
        type: 'message',
        timestamp: '2026-06-25T06:50:00.000Z',
        message: { role: 'user', content: 'Day 1 prompt', timestamp: 1_750_828_200 },
      }),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-06-25T06:50:10.000Z',
        message: { role: 'assistant', content: 'Day 1 words', timestamp: 1_750_828_210 },
      }),
    ].join('\n'), 'utf8');
    await writeFile(runTwoPath, [
      JSON.stringify({
        type: 'message',
        timestamp: '2026-06-26T06:50:00.000Z',
        message: { role: 'user', content: 'Day 2 prompt', timestamp: 1_750_914_600 },
      }),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-06-26T06:50:10.000Z',
        message: { role: 'assistant', content: 'Day 2 words', timestamp: 1_750_914_610 },
      }),
    ].join('\n'), 'utf8');

    const sessionKey = 'agent:main:cron:job-daily';
    await writeFile(join(sessionsDir, 'sessions.json'), JSON.stringify({
      [sessionKey]: { sessionFile: 'run-two.jsonl', updatedAt: 1_750_914_610_000 },
      [`${sessionKey}:run:run-one`]: { sessionFile: 'run-one.jsonl' },
      [`${sessionKey}:run:run-two`]: { sessionFile: 'run-two.jsonl' },
    }), 'utf8');

    const { buildCronSessionHistoryMessages: buildHistory, buildSessionFileIndex: buildIndex } =
      await import('@electron/gateway/cron-session-history');

    const filesBySessionKey = await buildIndex(join(sessionsDir, 'sessions.json'));
    const messages = await buildHistory({
      agentId: 'main',
      jobId: 'job-daily',
      sessionKey,
      runs: [
        { action: 'finished', status: 'ok', runAtMs: 1_750_828_210_000, sessionId: 'run-one' },
        { action: 'finished', status: 'ok', runAtMs: 1_750_914_610_000, sessionId: 'run-two' },
      ],
      job: { name: 'Daily English', payload: { message: 'Send 10 words' } },
      sessionsDir,
      filesBySessionKey,
    });

    expect(
      messages
        .filter((message) => message.role === 'user' || message.role === 'assistant')
        .map((message) => message.content),
    ).toEqual([
      'Day 1 prompt',
      'Day 1 words',
      'Day 2 prompt',
      'Day 2 words',
    ]);
  });
});
