export type TrajectoryModelCallTiming = {
  runId: string;
  submittedAt: string;
  completedAt: string;
  durationMs: number;
  model?: string;
  provider?: string;
};

export function parseTrajectoryModelCallTimings(content: string): TrajectoryModelCallTiming[] {
  const submittedAtByRunId = new Map<string, string>();
  const results: TrajectoryModelCallTiming[] = [];

  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = typeof parsed.type === 'string' ? parsed.type : '';
    const runId = typeof parsed.runId === 'string' ? parsed.runId : '';
    const ts = typeof parsed.ts === 'string' ? parsed.ts : '';
    if (!runId || !ts) continue;

    if (type === 'prompt.submitted') {
      submittedAtByRunId.set(runId, ts);
      continue;
    }

    if (type !== 'model.completed') continue;

    const submittedAt = submittedAtByRunId.get(runId);
    if (!submittedAt) continue;

    const durationMs = Date.parse(ts) - Date.parse(submittedAt);
    if (!Number.isFinite(durationMs) || durationMs < 0) continue;

    results.push({
      runId,
      submittedAt,
      completedAt: ts,
      durationMs,
      model: typeof parsed.modelId === 'string' ? parsed.modelId : undefined,
      provider: typeof parsed.provider === 'string' ? parsed.provider : undefined,
    });
  }

  return results;
}
