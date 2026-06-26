import type { RawMessage } from '@/stores/chat';
import {
  collectChildDelegationBindings,
  collectCompletedSubagentSessionKeys,
  type ChildDelegationBinding,
} from '@/lib/subagent-delegation';
import { isChildDelegationStillActive } from '@/lib/subagent-delegation-watch';

/** Per-child UI status — independent branches in a multi-spawn turn. */
export type ChildDelegationUiStatus = 'pending' | 'running' | 'completed' | 'stalled';

export type ChildDelegationSnapshot = {
  binding: ChildDelegationBinding;
  childSessionKey: string;
  label: string | null;
  status: ChildDelegationUiStatus;
  active: boolean;
};

export type DelegationTurnSnapshot = {
  bindings: ChildDelegationBinding[];
  children: ChildDelegationSnapshot[];
  /** Any sessions_spawn in scope (even before childSessionKey is known). */
  hasSpawnedChildren: boolean;
  /** At least one child still pending or processing on the gateway. */
  anyChildActive: boolean;
  /** Every known child binding has completion + gateway idle. */
  allChildrenSettled: boolean;
  activeChildCount: number;
  totalChildCount: number;
};

function resolveChildStatus(
  binding: ChildDelegationBinding,
  processing: ReadonlySet<string>,
  stalledChildSessionKey: string | null | undefined,
): ChildDelegationUiStatus {
  if (stalledChildSessionKey === binding.childSessionKey) return 'stalled';
  if (isChildDelegationStillActive(binding, processing)) return 'running';
  return 'completed';
}

/**
 * Derive per-child and aggregate delegation state for a transcript scope.
 * Use full `messages` for sidebar/global turn signals; pass `segmentMessages`
 * for execution-graph cards tied to one user turn.
 */
export function deriveDelegationTurnSnapshot(
  scopeMessages: readonly RawMessage[],
  processingSessionKeys: readonly string[],
  options?: {
    stalledChildSessionKey?: string | null;
    completedChildSessionKeys?: ReadonlySet<string>;
    hasSpawnedChildren?: boolean;
  },
): DelegationTurnSnapshot {
  const completed = options?.completedChildSessionKeys
    ?? collectCompletedSubagentSessionKeys([...scopeMessages]);
  const bindings = collectChildDelegationBindings([...scopeMessages], completed);
  const processing = new Set(processingSessionKeys);
  const hasSpawnedChildren = options?.hasSpawnedChildren ?? bindings.length > 0;

  const children: ChildDelegationSnapshot[] = bindings.map((binding) => {
    const status = resolveChildStatus(binding, processing, options?.stalledChildSessionKey);
    const active = isChildDelegationStillActive(binding, processing);
    return {
      binding,
      childSessionKey: binding.childSessionKey,
      label: binding.label,
      status,
      active,
    };
  });

  const anyChildActive = children.some((child) => child.active);
  const allChildrenSettled = bindings.length === 0
    ? !hasSpawnedChildren
    : children.every((child) => !child.active);
  const activeChildCount = children.filter((child) => child.active).length;

  return {
    bindings,
    children,
    hasSpawnedChildren,
    anyChildActive,
    allChildrenSettled,
    activeChildCount,
    totalChildCount: bindings.length,
  };
}

/** True while any spawned child is still in flight (transcript or gateway). */
export function hasOpenSubagentDelegations(
  messages: readonly RawMessage[],
  processingSessionKeys: readonly string[] = [],
): boolean {
  const snapshot = deriveDelegationTurnSnapshot(messages, processingSessionKeys);
  return snapshot.anyChildActive;
}

/** All children that are still active — supports parallel multi-spawn turns. */
export function collectActiveChildDelegations(
  messages: readonly RawMessage[],
  processingSessionKeys: readonly string[] = [],
  stalledChildSessionKey?: string | null,
): ChildDelegationSnapshot[] {
  const snapshot = deriveDelegationTurnSnapshot(messages, processingSessionKeys, {
    stalledChildSessionKey,
  });
  return snapshot.children.filter((child) => child.active);
}

/**
 * User turn stays open while children are active OR the main session is still
 * working after children return. Caller supplies main-session liveness.
 */
export function isDelegationPhaseOpen(
  delegation: DelegationTurnSnapshot,
  mainSessionActive: boolean,
): boolean {
  if (delegation.anyChildActive) return true;
  if (delegation.hasSpawnedChildren && !delegation.allChildrenSettled) return true;
  return mainSessionActive;
}
