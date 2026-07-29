import { listLocalDigitalEmployees } from '../digital-employee-storage';
import { getSetting } from '../store';

type RetiredDigitalEmployeeRecordLike = {
  name?: string;
};

/** Build runtime agentId -> display name map for skill-invoke uploads. */
export async function buildSkillInvokeAgentNameLookup(): Promise<Map<string, string>> {
  const lookup = new Map<string, string>();

  try {
    const employees = await listLocalDigitalEmployees();
    for (const employee of employees) {
      const agentId = employee.agentId.trim();
      const name = employee.name.trim();
      if (agentId && name) {
        lookup.set(agentId, name);
      }
    }
  } catch {
    // Upload must not fail when digital employee metadata is temporarily unreadable.
  }

  try {
    const uiState = await getSetting('uiState') as {
      digitalEmployees?: { retiredAgents?: Record<string, RetiredDigitalEmployeeRecordLike> };
    } | undefined;
    const retiredAgents = uiState?.digitalEmployees?.retiredAgents ?? {};
    for (const [agentId, record] of Object.entries(retiredAgents)) {
      const normalizedAgentId = agentId.trim();
      const name = record.name?.trim();
      if (!normalizedAgentId || !name || lookup.has(normalizedAgentId)) continue;
      lookup.set(normalizedAgentId, name);
    }
  } catch {
    // Retired-agent metadata is best-effort for upload normalization only.
  }

  return lookup;
}
