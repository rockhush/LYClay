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
