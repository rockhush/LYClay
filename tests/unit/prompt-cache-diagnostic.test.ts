import { describe, expect, it } from 'vitest';
import {
  buildPromptCacheDiagnosticReport,
  comparePromptPrefixes,
  parseTrajectoryTurns,
} from '@electron/utils/prompt-cache-diagnostic';

describe('prompt-cache-diagnostic', () => {
  it('parses trajectory turns and correlates cacheRead with prefix stability', () => {
    const jsonl = [
      JSON.stringify({
        type: 'context.compiled',
        ts: '2026-06-15T10:00:00.000Z',
        runId: 'run-1',
        modelId: 'auto',
        provider: 'ly-auto',
        data: {
          systemPrompt: 'stable system prompt',
          messages: [{ role: 'user', content: '/think off hello' }],
        },
      }),
      JSON.stringify({
        type: 'model.completed',
        ts: '2026-06-15T10:00:05.000Z',
        runId: 'run-1',
        modelId: 'auto',
        provider: 'ly-auto',
        data: {
          usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 80, total: 200 },
        },
      }),
      JSON.stringify({
        type: 'context.compiled',
        ts: '2026-06-15T10:01:00.000Z',
        runId: 'run-2',
        modelId: 'auto',
        provider: 'ly-auto',
        data: {
          systemPrompt: 'stable system prompt',
          messages: [
            { role: 'user', content: '/think off hello' },
            { role: 'assistant', content: 'hi there' },
            { role: 'user', content: '/think off follow up' },
          ],
        },
      }),
      JSON.stringify({
        type: 'model.completed',
        ts: '2026-06-15T10:01:05.000Z',
        runId: 'run-2',
        modelId: 'auto',
        provider: 'ly-auto',
        data: {
          usage: { input: 150, output: 25, cacheRead: 90, cacheWrite: 10, total: 275 },
        },
      }),
    ].join('\n');

    const report = buildPromptCacheDiagnosticReport('session.jsonl', jsonl);
    expect(report.summary.turnCount).toBe(2);
    expect(report.summary.cacheHitTurns).toBe(1);
    expect(report.summary.systemPromptDriftTurns).toBe(0);
    expect(report.summary.messagesPrefixBreakTurns).toBe(0);
    expect(report.prefixDiffs[0]?.messagesPrefixAppendOnly).toBe(true);
  });

  it('flags system prompt drift and non append-only message history', () => {
    const turns = parseTrajectoryTurns([
      JSON.stringify({
        type: 'context.compiled',
        ts: '2026-06-15T10:00:00.000Z',
        runId: 'run-1',
        data: {
          systemPrompt: 'version-a',
          messages: [{ role: 'user', content: 'one' }],
        },
      }),
      JSON.stringify({
        type: 'context.compiled',
        ts: '2026-06-15T10:01:00.000Z',
        runId: 'run-2',
        data: {
          systemPrompt: 'version-b',
          messages: [{ role: 'user', content: 'two' }],
        },
      }),
    ].join('\n'));

    const diffs = comparePromptPrefixes(turns);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.systemPromptChanged).toBe(true);
    expect(diffs[0]?.messagesPrefixAppendOnly).toBe(false);
  });
});
