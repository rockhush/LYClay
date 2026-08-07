import { hostApiFetch } from '@/lib/host-api';
import { reorderCronJobIds } from '@/lib/cron-job-order';
import type { Skill } from '@/types/skill';

let persistedSkillOrder: string[] = [];

export function getPersistedSkillOrder(): readonly string[] {
  return persistedSkillOrder;
}

export function setPersistedSkillOrder(order: readonly string[]): void {
  persistedSkillOrder = [...order];
}

export function applySkillOrder(skills: Skill[], order: readonly string[]): Skill[] {
  if (order.length === 0) return [...skills];
  const byId = new Map(skills.map((skill) => [skill.id, skill]));
  const ordered: Skill[] = [];
  for (const id of order) {
    const skill = byId.get(id);
    if (!skill) continue;
    ordered.push(skill);
    byId.delete(id);
  }
  for (const skill of skills) {
    if (byId.has(skill.id)) {
      ordered.push(skill);
    }
  }
  return ordered;
}

export function mergeSkillOrder(existingOrder: readonly string[], skills: readonly Skill[]): string[] {
  const skillIds = new Set(skills.map((skill) => skill.id));
  const merged = existingOrder.filter((id) => skillIds.has(id));
  const seen = new Set(merged);
  for (const skill of skills) {
    if (!seen.has(skill.id)) {
      merged.push(skill.id);
      seen.add(skill.id);
    }
  }
  return merged;
}

export function reorderSkillIds(order: readonly string[], fromId: string, toId: string): string[] {
  return reorderCronJobIds(order, fromId, toId);
}

export function removeSkillIdFromOrder(order: readonly string[], skillId: string): string[] {
  return order.filter((id) => id !== skillId);
}

export async function loadSkillOrder(): Promise<string[]> {
  try {
    const result = await hostApiFetch<{ success: boolean; state?: { skills?: { mySkillOrder?: string[] } } }>(
      '/api/ui-state',
    );
    const order = result.state?.skills?.mySkillOrder;
    if (!Array.isArray(order)) return [];
    const sanitized = order.filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
    setPersistedSkillOrder(sanitized);
    return sanitized;
  } catch {
    return [];
  }
}

export async function saveSkillOrder(order: readonly string[]): Promise<void> {
  setPersistedSkillOrder(order);
  await hostApiFetch('/api/ui-state', {
    method: 'PUT',
    body: JSON.stringify({ skills: { mySkillOrder: [...order] } }),
  });
}
