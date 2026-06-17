import type { LocalDigitalEmployee } from '@/types/digital-employee';
import type { CachedDigitalEmployeeDisplayMetadata } from '@/lib/digital-employee-display-cache';
import { resolveInstalledDigitalEmployeeForDisplay } from '@/lib/digital-employee-display-cache';
import type { MarketplaceAgent, MyAgent } from './mock-data';

export function mapInstalledEmployeeToMyAgent(
  employee: LocalDigitalEmployee,
  marketplace?: MarketplaceAgent,
  cached?: CachedDigitalEmployeeDisplayMetadata,
): MyAgent {
  const display = resolveInstalledDigitalEmployeeForDisplay(
    employee.marketEmployeeId,
    marketplace
      ? {
          version: marketplace.version,
          name: marketplace.name,
          author: marketplace.author,
          description: marketplace.description,
          updateTime: marketplace.updateTime,
          tags: marketplace.tags,
        }
      : undefined,
    cached,
  );

  return {
    id: employee.instanceId,
    marketEmployeeId: employee.marketEmployeeId,
    sessionKey: employee.sessionKey,
    agentId: employee.agentId,
    packageId: employee.packageId,
    name: display.name,
    description: display.description,
    version: display.version,
    author: display.author,
    enabled: employee.enabled,
    tags: display.tags ?? [],
  };
}

export function shouldIncludeInMyDigitalEmployees(
  employee: LocalDigitalEmployee,
  marketplaceCatalogBySlug: Map<string, MarketplaceAgent>,
  cached?: CachedDigitalEmployeeDisplayMetadata,
  options?: { marketplaceCatalogLoading?: boolean },
): boolean {
  if (marketplaceCatalogBySlug.has(employee.marketEmployeeId)) return true;

  const hasCachedDisplay = Boolean(
    cached?.name?.trim()
    || cached?.description?.trim()
    || cached?.author?.trim(),
  );

  if (options?.marketplaceCatalogLoading) {
    return hasCachedDisplay;
  }

  return hasCachedDisplay;
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
