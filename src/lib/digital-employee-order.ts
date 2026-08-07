import { hostApiFetch } from '@/lib/host-api';
import { reorderCronJobIds } from '@/lib/cron-job-order';
import type { MyAgent } from '@/pages/DigitalEmployee/mock-data';

let persistedEmployeeOrder: string[] = [];

export function getPersistedDigitalEmployeeOrder(): readonly string[] {
  return persistedEmployeeOrder;
}

export function setPersistedDigitalEmployeeOrder(order: readonly string[]): void {
  persistedEmployeeOrder = [...order];
}

export function applyDigitalEmployeeOrder(agents: MyAgent[], order: readonly string[]): MyAgent[] {
  if (order.length === 0) return [...agents];
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const ordered: MyAgent[] = [];
  for (const id of order) {
    const agent = byId.get(id);
    if (!agent) continue;
    ordered.push(agent);
    byId.delete(id);
  }
  for (const agent of agents) {
    if (byId.has(agent.id)) {
      ordered.push(agent);
    }
  }
  return ordered;
}

export function mergeDigitalEmployeeOrder(
  existingOrder: readonly string[],
  agents: readonly MyAgent[],
): string[] {
  const agentIds = new Set(agents.map((agent) => agent.id));
  const merged = existingOrder.filter((id) => agentIds.has(id));
  const seen = new Set(merged);
  for (const agent of agents) {
    if (!seen.has(agent.id)) {
      merged.push(agent.id);
      seen.add(agent.id);
    }
  }
  return merged;
}

export function removeDigitalEmployeeIdFromOrder(order: readonly string[], agentId: string): string[] {
  return order.filter((id) => id !== agentId);
}

export async function loadDigitalEmployeeOrder(): Promise<string[]> {
  try {
    const result = await hostApiFetch<{
      success: boolean;
      state?: { digitalEmployees?: { myEmployeeOrder?: string[] } };
    }>('/api/ui-state');
    const order = result.state?.digitalEmployees?.myEmployeeOrder;
    if (!Array.isArray(order)) return [];
    const sanitized = order.filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
    setPersistedDigitalEmployeeOrder(sanitized);
    return sanitized;
  } catch {
    return [];
  }
}

export async function saveDigitalEmployeeOrder(order: readonly string[]): Promise<void> {
  setPersistedDigitalEmployeeOrder(order);
  await hostApiFetch('/api/ui-state', {
    method: 'PUT',
    body: JSON.stringify({ digitalEmployees: { myEmployeeOrder: [...order] } }),
  });
}
