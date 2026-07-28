import { listLocalDigitalEmployees } from '../digital-employee-storage';
import { getSetting } from '../store';

type RetiredDigitalEmployeeRecordLike = {
  marketEmployeeId?: string;
};

/** Build runtime agentId -> backend marketEmployeeId map for execution uploads. */
export async function buildExecutionReportAgentIdLookup(): Promise<Map<string, string>> {
  const lookup = new Map<string, string>();

  try {
    const employees = await listLocalDigitalEmployees();
    for (const employee of employees) {
      const marketEmployeeId = employee.marketEmployeeId.trim();
      const agentId = employee.agentId.trim();
      if (marketEmployeeId && agentId) {
        lookup.set(agentId, marketEmployeeId);
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
      const marketEmployeeId = record.marketEmployeeId?.trim();
      if (!normalizedAgentId || !marketEmployeeId || lookup.has(normalizedAgentId)) continue;
      lookup.set(normalizedAgentId, marketEmployeeId);
    }
  } catch {
    // Retired-agent metadata is best-effort for upload normalization only.
  }

  return lookup;
}
