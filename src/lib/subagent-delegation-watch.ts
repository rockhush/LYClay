import type { ChildDelegationBinding } from '@/lib/subagent-delegation';
import { isSubagentSessionKey } from '@/lib/session-key-utils';

export type ChildTranscriptRevision = {
  messageCount: number;
  updatedAt: number;
};

/** No transcript progress while Gateway still reports the child session processing. */
export const SUBAGENT_STALL_WHILE_PROCESSING_MS = 90_000;

/** No completion event and no transcript progress for an extended period. */
export const SUBAGENT_STALL_IDLE_MS = 180_000;

export function filterProcessingSubagentKeys(sessionKeys: readonly string[]): string[] {
  return sessionKeys.filter((key) => isSubagentSessionKey(key));
}

export function isChildDelegationStillActive(
  binding: ChildDelegationBinding,
  processingSessionKeys: ReadonlySet<string>,
): boolean {
  if (!binding.completed) return true;
  return processingSessionKeys.has(binding.childSessionKey);
}

export function hasActiveChildDelegations(
  bindings: readonly ChildDelegationBinding[],
  processingSessionKeys: readonly string[],
): boolean {
  const processing = new Set(processingSessionKeys);
  return bindings.some((binding) => isChildDelegationStillActive(binding, processing));
}

export function isSubagentStalledErrorMessage(error: string | null | undefined): boolean {
  if (!error) return false;
  return /子任务「.+」长时间无进展/.test(error)
    || /Sub-task ".+" stopped making progress/i.test(error);
}

export function detectStalledChildDelegation(
  bindings: readonly ChildDelegationBinding[],
  revisions: ReadonlyMap<string, ChildTranscriptRevision>,
  processingSessionKeys: readonly string[],
  nowMs = Date.now(),
): ChildDelegationBinding | null {
  const processing = new Set(processingSessionKeys);

  for (let i = bindings.length - 1; i >= 0; i -= 1) {
    const binding = bindings[i]!;
    if (!isChildDelegationStillActive(binding, processing)) continue;

    const revision = revisions.get(binding.childSessionKey);
    if (!revision) continue;
    const idleMs = nowMs - revision.updatedAt;
    const processingOnGateway = processing.has(binding.childSessionKey);

    if (processingOnGateway && idleMs >= SUBAGENT_STALL_WHILE_PROCESSING_MS) {
      return binding;
    }
    if (!binding.completed && idleMs >= SUBAGENT_STALL_IDLE_MS) {
      return binding;
    }
  }

  return null;
}
