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

/**
 * DISPLAY liveness: a child branch stays "running" (and keeps polling) until the
 * parent transcript commits its completion marker OR the gateway stops listing it.
 *
 * This intentionally keeps the branch running across transient gaps in the
 * gateway's `processingSessionKeys` right after spawn — otherwise the nested
 * execution graph flips to "subagent run 完成" prematurely and stops updating.
 *
 * For TURN-FINALIZE decisions (whether the parent turn may end) use the
 * gateway-only `isChildDelegationGatewayActive` instead, so a missing/late
 * transcript marker can never strand the parent in a "thinking" state.
 */
export function isChildDelegationStillActive(
  binding: ChildDelegationBinding,
  processingSessionKeys: ReadonlySet<string>,
): boolean {
  if (!binding.completed) return true;
  return processingSessionKeys.has(binding.childSessionKey);
}

/** Gateway-only liveness used for finalize/backend-work checks. */
export function isChildDelegationGatewayActive(
  binding: ChildDelegationBinding,
  processingSessionKeys: ReadonlySet<string>,
): boolean {
  return processingSessionKeys.has(binding.childSessionKey);
}

export function hasActiveChildDelegations(
  bindings: readonly ChildDelegationBinding[],
  processingSessionKeys: readonly string[],
): boolean {
  const processing = new Set(processingSessionKeys);
  return bindings.some((binding) => isChildDelegationStillActive(binding, processing));
}

/** Gateway-only variant of {@link hasActiveChildDelegations} for finalize checks. */
export function hasGatewayActiveChildDelegations(
  bindings: readonly ChildDelegationBinding[],
  processingSessionKeys: readonly string[],
): boolean {
  const processing = new Set(processingSessionKeys);
  return bindings.some((binding) => isChildDelegationGatewayActive(binding, processing));
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
