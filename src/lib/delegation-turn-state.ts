import { extractText, extractToolUse } from '@/pages/Chat/message-utils';
import type { RawMessage } from '@/stores/chat';
import {
  findConcludingAssistantReply,
  findLatestVisibleUserIndex,
  isTerminalAssistantMessage,
  shouldSilentlyFinalizeRunOnAssistantFinal,
} from '@/stores/chat/run-lifecycle';
import {
  collectChildDelegationBindings,
  collectCompletedSubagentSessionKeys,
  hasUnresolvedSpawnDelegation,
  isInterimSubagentWaitAssistantReply,
  isVisibleWrapUpAssistantReply,
  type ChildDelegationBinding,
} from '@/lib/subagent-delegation';
import {
  isChildDelegationGatewayActive,
  isChildDelegationStillActive,
} from '@/lib/subagent-delegation-watch';

/** Per-child UI status �?independent branches in a multi-spawn turn. */
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
    // `status` is DISPLAY-robust (stays "running" until the transcript marker
    // commits) so the nested branch keeps rendering + polling across transient
    // gateway gaps. `active` is GATEWAY-ONLY so it never blocks the parent turn
    // from finalizing once the gateway reports the child idle.
    const status = resolveChildStatus(binding, processing, options?.stalledChildSessionKey);
    // Completed children (transcript marker or announce wrap-up) must never keep
    // the parent turn active on stale gateway processingSessionKeys lag.
    const active = binding.completed
      ? false
      : isChildDelegationGatewayActive(binding, processing);
    return {
      binding,
      childSessionKey: binding.childSessionKey,
      label: binding.label,
      status,
      active,
    };
  });

  const anyChildActive = children.some((child) => child.active);
  // With no tracked child bindings, the turn is settled unless a spawn is still
  // genuinely pending (its tool result hasn't committed yet). A committed but
  // unbindable spawn (fire-and-forget `mode:run` `{status:accepted}` or a
  // timed-out child) has no transcript child to wait on �?gateway processing
  // keys are the source of truth for those, so it must not block finalize.
  const allChildrenSettled = bindings.length === 0
    ? !hasUnresolvedSpawnDelegation(scopeMessages)
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

/** All children that are still active �?supports parallel multi-spawn turns. */
export function collectActiveChildDelegations(
  messages: readonly RawMessage[],
  processingSessionKeys: readonly string[] = [],
  stalledChildSessionKey?: string | null,
  completedChildSessionKeys?: ReadonlySet<string>,
): ChildDelegationSnapshot[] {
  const snapshot = deriveDelegationTurnSnapshot(messages, processingSessionKeys, {
    stalledChildSessionKey,
    completedChildSessionKeys,
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

function toMs(timestamp: number): number {
  return timestamp < 1e12 ? Math.round(timestamp * 1000) : Math.round(timestamp);
}

function resolveTurnScope(
  messages: readonly RawMessage[],
  lastUserMessageAt?: number | null,
): RawMessage[] {
  if (lastUserMessageAt != null) {
    const turnStartMs = toMs(lastUserMessageAt);
    let startIdx = findLatestVisibleUserIndex([...messages]);
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message?.role !== 'user') continue;
      const timestampMs = message.timestamp != null ? toMs(message.timestamp) : null;
      if (timestampMs == null || timestampMs >= turnStartMs) {
        startIdx = i;
        break;
      }
    }
    return messages.slice(startIdx >= 0 ? startIdx : 0);
  }

  const userIdx = findLatestVisibleUserIndex([...messages]);
  return userIdx >= 0 ? messages.slice(userIdx) : [...messages];
}

function hasSessionsSpawnInScope(scopeMessages: readonly RawMessage[]): boolean {
  return scopeMessages.some((message) =>
    message.role === 'assistant'
    && extractToolUse(message).some((tool) => /sessions_spawn/i.test(tool.name)),
  );
}

function hasPostDelegationParentConclusion(
  scopeMessages: readonly RawMessage[],
  processingSessionKeys: readonly string[],
  completedChildSessionKeys?: ReadonlySet<string>,
): boolean {
  if (!hasSessionsSpawnInScope(scopeMessages)) return false;

  const firstSpawnIdx = scopeMessages.findIndex((message) =>
    message.role === 'assistant'
    && extractToolUse(message).some((tool) => /sessions_spawn/i.test(tool.name)),
  );
  if (firstSpawnIdx < 0) return false;

  const afterSpawn = scopeMessages.slice(firstSpawnIdx + 1);
  const hasDeliverableTerminalWrapUp = afterSpawn.some((message) =>
    isVisibleWrapUpAssistantReply(message, scopeMessages),
  );
  const concluding = findConcludingAssistantReply(scopeMessages);
  const hasConcludingWrapUp = Boolean(
    concluding
    && !shouldSilentlyFinalizeRunOnAssistantFinal(concluding)
    && !isInterimSubagentWaitAssistantReply(concluding)
    && scopeMessages.indexOf(concluding) > firstSpawnIdx,
  );

  if (hasDeliverableTerminalWrapUp || hasConcludingWrapUp) {
    const completed = new Set([
      ...collectCompletedSubagentSessionKeys([...scopeMessages]),
      ...(completedChildSessionKeys ?? []),
    ]);
    let bindings = collectChildDelegationBindings([...scopeMessages], completed);
    const pendingBindings = bindings.filter((binding) => !binding.completed);
    const deliverableWrapUp = afterSpawn.some((message) =>
      isVisibleWrapUpAssistantReply(message, scopeMessages),
    );

    // Single-spawn announce/yield wrap-ups settle even when gateway child keys lag.
    // Multi-spawn turns require every child binding to complete first.
    if (deliverableWrapUp) {
      if (bindings.length > 1) {
        if (pendingBindings.length === 0) {
          const stillActiveChild = bindings.some((binding) =>
            !binding.completed && processingSessionKeys.includes(binding.childSessionKey),
          );
          if (!stillActiveChild) return true;
        }
      } else if (pendingBindings.length <= 1) {
        if (pendingBindings.length === 1) {
          completed.add(pendingBindings[0].childSessionKey);
          bindings = collectChildDelegationBindings([...scopeMessages], completed);
        }
        const stillActiveChild = bindings.some((binding) =>
          !binding.completed && processingSessionKeys.includes(binding.childSessionKey),
        );
        if (!stillActiveChild) return true;
      }
    }
  }

  const completed = new Set([
    ...collectCompletedSubagentSessionKeys([...scopeMessages]),
    ...(completedChildSessionKeys ?? []),
  ]);
  const bindings = collectChildDelegationBindings([...scopeMessages], completed);
  const gatewayChildActive = bindings.some((binding) =>
    !binding.completed && processingSessionKeys.includes(binding.childSessionKey),
  );
  if (gatewayChildActive) return false;

  const snapshot = deriveDelegationTurnSnapshot(scopeMessages, processingSessionKeys, {
    hasSpawnedChildren: true,
    completedChildSessionKeys: completed,
  });
  if (!snapshot.allChildrenSettled) return false;

  return false;
}

function isDelegationScopeOpen(
  scope: readonly RawMessage[],
  processingSessionKeys: readonly string[],
  options?: {
    streamingMessage?: unknown | null;
    completedChildSessionKeys?: ReadonlySet<string>;
  },
): boolean {
  if (scope.length === 0) return false;

  const hasSpawn = hasSessionsSpawnInScope(scope) || hasUnresolvedSpawnDelegation(scope);
  const completed = new Set([
    ...collectCompletedSubagentSessionKeys([...scope]),
    ...(options?.completedChildSessionKeys ?? []),
  ]);
  const bindings = collectChildDelegationBindings([...scope], completed);
  if (!hasSpawn && bindings.length === 0) return false;

  if (hasPostDelegationParentConclusion(scope, processingSessionKeys, completed)) return false;

  if (options?.streamingMessage && typeof options.streamingMessage === 'object') {
    const tools = extractToolUse(options.streamingMessage as RawMessage);
    if (tools.some((tool) => /sessions_spawn/i.test(tool.name))) return true;
  }

  const snapshot = deriveDelegationTurnSnapshot(scope, processingSessionKeys, {
    hasSpawnedChildren: hasSpawn || bindings.length > 0,
    completedChildSessionKeys: completed,
  });

  // Parent announce wrap-up streams on the main session after children go idle.
  const gatewayChildActive = bindings.some((binding) =>
    !binding.completed && processingSessionKeys.includes(binding.childSessionKey),
  );
  if (!gatewayChildActive && hasSessionsSpawnInScope(scope)) {
    if (options?.streamingMessage && typeof options.streamingMessage === 'object') {
      const streamText = extractText(options.streamingMessage as RawMessage).trim();
      if (streamText.length > 0) return false;
    }
  }

  if (snapshot.anyChildActive || hasUnresolvedSpawnDelegation(scope)) return true;
  if (!snapshot.allChildrenSettled) return true;

  // Spawn accepted but no completion marker / deliverable wrap-up yet. Keep open
  // while the parent already posted an interim wait message or gateway still
  // tracks the child — not for a bare spawn+result with gateway fully idle.
  if (bindings.some((binding) => !binding.completed)) {
    const awaitingParentInterim = scope.some((message) =>
      message.role === 'assistant' && isInterimSubagentWaitAssistantReply(message),
    );
    const childOnGateway = bindings.some((binding) =>
      !binding.completed && processingSessionKeys.includes(binding.childSessionKey),
    );
    if (awaitingParentInterim || childOnGateway) return true;
  }

  const firstSpawnIdx = scope.findIndex((message) =>
    message.role === 'assistant'
    && extractToolUse(message).some((tool) => /sessions_spawn/i.test(tool.name)),
  );
  if (firstSpawnIdx >= 0) {
    const afterSpawn = scope.slice(firstSpawnIdx + 1);
    const latestAssistant = [...afterSpawn].reverse().find((message) =>
      message.role === 'assistant' && extractText(message).trim().length > 0,
    );
    const latestText = latestAssistant ? extractText(latestAssistant).trim() : '';
    if (
      latestAssistant
      && !/^\[Internal task completion event\]/i.test(latestText)
      && isInterimSubagentWaitAssistantReply(latestAssistant)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Parent user turn stays open across spawn �?child execution �?parent wrap-up.
 * Scopes to the active user turn when `lastUserMessageAt` is provided.
 */
export function isParentDelegationPhaseOpen(
  messages: readonly RawMessage[],
  processingSessionKeys: readonly string[],
  options?: {
    lastUserMessageAt?: number | null;
    streamingMessage?: unknown | null;
    completedChildSessionKeys?: ReadonlySet<string>;
  },
): boolean {
  const scope = resolveTurnScope(messages, options?.lastUserMessageAt);
  return isDelegationScopeOpen(scope, processingSessionKeys, options);
}

/** Whether the active visible user turn contains a sessions_spawn attempt. */
export function hasDelegationSpawnForActiveTurn(
  messages: readonly RawMessage[],
  options?: {
    lastUserMessageAt?: number | null;
  },
): boolean {
  const scope = resolveTurnScope(messages, options?.lastUserMessageAt);
  return hasSessionsSpawnInScope(scope) || hasUnresolvedSpawnDelegation(scope);
}
/** Delegation phase for a single user-turn segment (already sliced). */
export function isSegmentDelegationPhaseOpen(
  segmentMessages: readonly RawMessage[],
  processingSessionKeys: readonly string[],
  options?: {
    streamingMessage?: unknown | null;
    completedChildSessionKeys?: ReadonlySet<string>;
  },
): boolean {
  return isDelegationScopeOpen(segmentMessages, processingSessionKeys, options);
}

/**
 * Parent turn received a visible wrap-up reply after spawn and gateway children
 * are idle �?stale `pendingFinal` / `sending` must not keep the UI executing.
 */
export function isDelegationWrapUpComplete(
  messages: readonly RawMessage[],
  processingSessionKeys: readonly string[],
  options?: {
    lastUserMessageAt?: number | null;
    completedChildSessionKeys?: ReadonlySet<string>;
  },
): boolean {
  const scope = resolveTurnScope(messages, options?.lastUserMessageAt);
  if (!hasSessionsSpawnInScope(scope)) return false;
  if (isDelegationScopeOpen(scope, processingSessionKeys, {
    completedChildSessionKeys: options?.completedChildSessionKeys,
  })) return false;
  return hasPostDelegationParentConclusion(
    scope,
    processingSessionKeys,
    options?.completedChildSessionKeys,
  );
}
