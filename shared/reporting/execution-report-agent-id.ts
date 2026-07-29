export type ExecutionReportAgentType = 'normal' | 'digital_employee';

/**
 * Infer backend-facing market agent id from a runtime digital-employee instance id.
 * Example: employee-recruitment-specialist-8f6b71f4 -> employee-recruitment-specialist
 */
export function inferMarketEmployeeAgentIdFromInstanceId(agentId: string): string | null {
  const trimmed = agentId.trim();
  if (!trimmed.startsWith('employee-')) return null;
  const body = trimmed.slice('employee-'.length);
  // Instance ids append a random hex suffix (see createDigitalEmployeeInstallIdentity).
  const match = body.match(/^(.+)-[a-f0-9]{4,12}$/i);
  const slug = match?.[1]?.trim();
  return slug ? `employee-${slug}` : null;
}

/** Resolve the agent id sent to `/management/claw/report/execution`. */
export function resolveExecutionReportAgentId(
  agentId: string,
  agentType: ExecutionReportAgentType,
  lookup?: ReadonlyMap<string, string>,
): string {
  const trimmed = agentId.trim();
  if (!trimmed) return trimmed;
  if (agentType !== 'digital_employee' && !trimmed.startsWith('employee-')) {
    return trimmed;
  }

  const fromLookup = lookup?.get(trimmed)?.trim();
  if (fromLookup) return fromLookup;

  const inferred = inferMarketEmployeeAgentIdFromInstanceId(trimmed);
  if (inferred) return inferred;

  return trimmed;
}

/** Keep conversationId aligned when runtime and report agent ids differ. */
export function resolveExecutionReportConversationId(
  conversationId: string,
  runtimeAgentId: string,
  reportAgentId: string,
): string {
  const trimmedConversationId = conversationId.trim();
  const trimmedRuntimeAgentId = runtimeAgentId.trim();
  const trimmedReportAgentId = reportAgentId.trim();
  if (!trimmedConversationId || trimmedReportAgentId === trimmedRuntimeAgentId) {
    return trimmedConversationId;
  }

  const prefix = `agent:${trimmedRuntimeAgentId}:`;
  if (trimmedConversationId.startsWith(prefix)) {
    return `agent:${trimmedReportAgentId}:${trimmedConversationId.slice(prefix.length)}`;
  }
  return trimmedConversationId;
}

/**
 * Shorten scheduled-task session keys for backend upload.
 * Local queue/storage keeps the full `agent:{agentId}:scheduled-task:...` key;
 * the backend rejects overlong conversation ids for `entrySource=schedule`.
 */
export function resolveScheduleReportConversationId(conversationId: string): string | undefined {
  const trimmed = conversationId.trim();
  if (!trimmed.startsWith('agent:')) return undefined;

  const parts = trimmed.split(':');
  if (parts.length < 4) return undefined;

  const namespace = parts[2];
  if (namespace === 'scheduled-task' && parts.length >= 5) {
    const runSessionId = parts[4]?.trim();
    return runSessionId || undefined;
  }

  if (namespace === 'cron-run' && parts.length >= 5) {
    const runSessionId = parts[4]?.trim();
    return runSessionId || undefined;
  }

  if (namespace === 'cron') {
    if (parts.length >= 6 && parts[4] === 'run') {
      const runSessionId = parts[5]?.trim();
      return runSessionId || undefined;
    }
    if (parts.length >= 5) {
      const runSessionId = parts[4]?.trim();
      return runSessionId || undefined;
    }
    const jobId = parts[3]?.trim();
    return jobId || undefined;
  }

  return undefined;
}

/** Final conversation id sent to `/management/claw/report/execution`. */
export function resolveExecutionReportConversationIdForUpload(
  conversationId: string,
  entrySource: 'chat' | 'digital_employee' | 'schedule',
  runtimeAgentId: string,
  reportAgentId: string,
): string {
  if (entrySource === 'schedule') {
    const scheduleConversationId = resolveScheduleReportConversationId(conversationId);
    if (scheduleConversationId) return scheduleConversationId;
  }

  return resolveExecutionReportConversationId(
    conversationId,
    runtimeAgentId,
    reportAgentId,
  );
}
