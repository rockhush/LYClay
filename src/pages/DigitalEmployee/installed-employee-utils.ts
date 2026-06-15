import type { LocalDigitalEmployee } from '@/types/digital-employee';
import type { MarketplaceAgent, MyAgent } from './mock-data';

export function mapInstalledEmployeeToMyAgent(
  employee: LocalDigitalEmployee,
  marketplace?: MarketplaceAgent,
): MyAgent {
  // Display info is sourced exclusively from the digital-employee marketplace
  // (backend API). Local manifest fields from install.json/employee.json are
  // never used for display — even when the marketplace value is empty. Only
  // runtime fields (instanceId/sessionKey/agentId/packageId/enabled) come from
  // the local install record because the marketplace does not provide them.
  return {
    id: employee.instanceId,
    marketEmployeeId: employee.marketEmployeeId,
    sessionKey: employee.sessionKey,
    agentId: employee.agentId,
    packageId: employee.packageId,
    name: marketplace?.name?.trim() ?? '',
    description: marketplace?.description?.trim() ?? '',
    version: marketplace?.version?.trim() ?? '',
    author: marketplace?.author?.trim() ?? '',
    enabled: employee.enabled,
    tags: marketplace?.tags ?? [],
  };
}

export function groupInstalledEmployeesByMarketId(
  employees: LocalDigitalEmployee[],
): Map<string, LocalDigitalEmployee[]> {
  const grouped = new Map<string, LocalDigitalEmployee[]>();
  for (const employee of employees) {
    const bucket = grouped.get(employee.marketEmployeeId) ?? [];
    bucket.push(employee);
    grouped.set(employee.marketEmployeeId, bucket);
  }
  return grouped;
}
