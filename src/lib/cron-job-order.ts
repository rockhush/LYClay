import { hostApiFetch } from '@/lib/host-api';
import type { CronJob } from '@/types/cron';

export function applyCronJobOrder(jobs: CronJob[], order: readonly string[]): CronJob[] {
  if (order.length === 0) return [...jobs];
  const byId = new Map(jobs.map((job) => [job.id, job]));
  const ordered: CronJob[] = [];
  for (const id of order) {
    const job = byId.get(id);
    if (!job) continue;
    ordered.push(job);
    byId.delete(id);
  }
  for (const job of jobs) {
    if (byId.has(job.id)) {
      ordered.push(job);
    }
  }
  return ordered;
}

export function mergeCronJobOrder(existingOrder: readonly string[], jobs: readonly CronJob[]): string[] {
  const jobIds = new Set(jobs.map((job) => job.id));
  const merged = existingOrder.filter((id) => jobIds.has(id));
  const seen = new Set(merged);
  for (const job of jobs) {
    if (!seen.has(job.id)) {
      merged.push(job.id);
      seen.add(job.id);
    }
  }
  return merged;
}

/** Swap two task ids in place; other positions stay unchanged. */
export function reorderCronJobIds(order: readonly string[], fromId: string, toId: string): string[] {
  if (fromId === toId) return [...order];
  const fromIndex = order.indexOf(fromId);
  const toIndex = order.indexOf(toId);
  if (fromIndex === -1 || toIndex === -1) return [...order];

  const next = [...order];
  next[fromIndex] = toId;
  next[toIndex] = fromId;
  return next;
}

export function removeCronJobIdFromOrder(order: readonly string[], jobId: string): string[] {
  return order.filter((id) => id !== jobId);
}

export async function loadCronJobOrder(): Promise<string[]> {
  try {
    const result = await hostApiFetch<{ success: boolean; state?: { cron?: { jobOrder?: string[] } } }>(
      '/api/ui-state',
    );
    const order = result.state?.cron?.jobOrder;
    if (!Array.isArray(order)) return [];
    return order.filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
  } catch {
    return [];
  }
}

export async function saveCronJobOrder(order: readonly string[]): Promise<void> {
  await hostApiFetch('/api/ui-state', {
    method: 'PUT',
    body: JSON.stringify({ cron: { jobOrder: [...order] } }),
  });
}
