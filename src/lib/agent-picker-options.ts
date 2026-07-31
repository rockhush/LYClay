import type { AgentSummary } from '@/types/agent';

export type AgentPickerCandidate = Pick<AgentSummary, 'id' | 'name' | 'isDigitalEmployee'>;

function normalizeAgentName(name: string): string {
  return name.trim().toLowerCase();
}

export function isDigitalEmployeeAgentCandidate(agent: AgentPickerCandidate): boolean {
  return agent.isDigitalEmployee === true || agent.id.startsWith('employee-');
}

/** Agents eligible for bind/pick lists: non-DE agents plus currently installed digital employees. */
export function filterAgentsForAgentPicker(
  agents: readonly AgentPickerCandidate[],
  options?: { includeAgentIds?: readonly string[] },
): AgentPickerCandidate[] {
  const forceInclude = new Set(
    (options?.includeAgentIds ?? []).map((id) => id.trim()).filter(Boolean),
  );

  const filtered = agents.filter((agent) => {
    if (forceInclude.has(agent.id)) return true;
    if (!isDigitalEmployeeAgentCandidate(agent)) return true;
    return agent.isDigitalEmployee === true;
  });

  const seenNames = new Set<string>();
  const deduped: AgentPickerCandidate[] = [];
  for (const agent of filtered) {
    const nameKey = normalizeAgentName(agent.name || agent.id);
    if (seenNames.has(nameKey)) continue;
    seenNames.add(nameKey);
    deduped.push(agent);
  }

  return deduped;
}

export function resolveAgentPickerLabel(
  agentId: string | undefined,
  agents: readonly AgentPickerCandidate[],
  fallback = '',
): string {
  if (!agentId) return fallback;
  const agent = agents.find((entry) => entry.id === agentId);
  const name = agent?.name?.trim();
  if (name) return name;
  if (agentId.startsWith('employee-')) {
    const slug = agentId.slice('employee-'.length).replace(/-[a-z0-9]{4,12}$/i, '');
    return slug || fallback;
  }
  return fallback || agentId;
}
