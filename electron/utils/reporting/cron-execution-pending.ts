/**
 * Tracks cron-supervisor initiated chat.send runs until Gateway reports terminal.
 * Only runs registered here are reported from main — user follow-ups in the same
 * scheduled-task session continue to use the renderer execution-turn tracker.
 */

export interface CronExecutionPending {
  runId: string;
  sessionKey: string;
  agentId: string;
  registeredAtMs: number;
}

const pendingByRunId = new Map<string, CronExecutionPending>();
const reportedRunIds = new Set<string>();

export function registerCronExecutionPending(pending: CronExecutionPending): void {
  pendingByRunId.set(pending.runId, pending);
}

export function getCronExecutionPending(runId: string): CronExecutionPending | undefined {
  return pendingByRunId.get(runId);
}

export function takeCronExecutionPending(runId: string): CronExecutionPending | undefined {
  const pending = pendingByRunId.get(runId);
  if (!pending) return undefined;
  pendingByRunId.delete(runId);
  return pending;
}

export function isCronExecutionReported(runId: string): boolean {
  return reportedRunIds.has(runId);
}

export function markCronExecutionReported(runId: string): void {
  reportedRunIds.add(runId);
  if (reportedRunIds.size > 2_000) {
    reportedRunIds.clear();
    reportedRunIds.add(runId);
  }
}

/** Test helper — resets in-memory registry state. */
export function clearCronExecutionPendingState(): void {
  pendingByRunId.clear();
  reportedRunIds.clear();
}
