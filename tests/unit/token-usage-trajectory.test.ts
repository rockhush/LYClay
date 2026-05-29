import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseUsageEntriesFromJsonl } from '@electron/utils/token-usage-core';
import {
  findTrajectoryUsageSupplement,
  parseTrajectoryUsageSupplements,
} from '@electron/utils/token-usage-trajectory';

describe('token usage trajectory supplements', () => {
  it('estimates input/output from trajectory when session usage is all zero', () => {
    const trajectory = [
      JSON.stringify({
        type: 'context.compiled',
        ts: '2026-05-29T05:15:20.299Z',
        runId: 'run-1',
        provider: 'ly-qwen',
        modelId: 'qwen3.5-397b',
        data: {
          systemPrompt: 'You are a personal assistant running inside OpenClaw.\n'.repeat(400),
          prompt: '请问一下我当前的模型是？',
        },
      }),
      JSON.stringify({
        type: 'model.completed',
        ts: '2026-05-29T05:15:23.164Z',
        runId: 'run-1',
        provider: 'ly-qwen',
        modelId: 'qwen3.5-397b',
        data: {
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          assistantTexts: ['你当前的模型是 **ly-qwen/qwen3.5-397b**。'],
        },
      }),
    ].join('\n');

    const jsonl = [
      JSON.stringify({
        type: 'message',
        timestamp: '2026-05-29T05:15:23.120Z',
        message: {
          role: 'assistant',
          provider: 'ly-qwen',
          model: 'qwen3.5-397b',
          content: [{ type: 'text', text: '你当前的模型是 **ly-qwen/qwen3.5-397b**。' }],
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
          },
        },
      }),
    ].join('\n');

    const supplements = parseTrajectoryUsageSupplements(trajectory);
    expect(supplements).toHaveLength(1);
    expect(supplements[0]?.totalTokens).toBeGreaterThan(0);

    const entries = parseUsageEntriesFromJsonl(
      jsonl,
      { sessionId: 'session-1', agentId: 'main' },
      undefined,
      { trajectorySupplements: supplements },
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.totalTokens).toBeGreaterThan(0);
    expect(entries[0]?.inputTokens).toBeGreaterThan(0);
    expect(entries[0]?.outputTokens).toBeGreaterThan(0);
  });

  it('matches trajectory supplements by nearby timestamp', () => {
    const supplements = parseTrajectoryUsageSupplements([
      JSON.stringify({
        type: 'context.compiled',
        ts: '2026-05-29T05:15:20.299Z',
        runId: 'run-1',
        data: { prompt: 'hello world' },
      }),
      JSON.stringify({
        type: 'model.completed',
        ts: '2026-05-29T05:15:23.164Z',
        runId: 'run-1',
        data: { assistantTexts: ['response text'] },
      }),
    ].join('\n'));

    const matched = findTrajectoryUsageSupplement(supplements, '2026-05-29T05:15:23.120Z');
    expect(matched?.runId).toBe('run-1');
  });

  it('parses real qwen session trajectory when present locally', () => {
    const home = process.env.USERPROFILE || process.env.HOME;
    if (!home) return;

    const trajectoryPath = join(
      home,
      '.openclaw',
      'agents',
      'main',
      'sessions',
      '18a8b22b-ac6f-4ffa-acc4-0f527e7d4f76.trajectory.jsonl',
    );
    let trajectory = '';
    try {
      trajectory = readFileSync(trajectoryPath, 'utf8');
    } catch {
      return;
    }

    const supplements = parseTrajectoryUsageSupplements(trajectory);
    expect(supplements.length).toBeGreaterThan(0);
    expect(supplements[0]?.totalTokens).toBeGreaterThan(0);
  });
});
