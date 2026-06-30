import { collectChildDelegationBindings, collectCompletedSubagentSessionKeys } from '@/lib/subagent-delegation';
import { isChildDelegationStillActive } from '@/lib/subagent-delegation-watch';
import type { RawMessage } from './types';
import { persistUserAbortedSession } from './user-aborted-sessions';

type GatewayRpc = (
  method: string,
  params: Record<string, unknown>,
  timeoutMs?: number,
) => Promise<unknown>;

function collectChildSessionsToAbort(
  messages: RawMessage[],
  processingSessionKeys: readonly string[] = [],
): Map<string, string | null> {
  const completed = collectCompletedSubagentSessionKeys(messages);
  const bindings = collectChildDelegationBindings(messages, completed);
  const processing = new Set(processingSessionKeys);
  const toAbort = new Map<string, string | null>();

  for (const binding of bindings) {
    if (isChildDelegationStillActive(binding, processing)) {
      toAbort.set(binding.childSessionKey, binding.runId);
    }
  }

  for (const key of processingSessionKeys) {
    if (!bindings.some((binding) => binding.childSessionKey === key)) continue;
    if (!toAbort.has(key)) {
      const binding = bindings.find((candidate) => candidate.childSessionKey === key);
      toAbort.set(key, binding?.runId ?? null);
    }
  }

  return toAbort;
}

/**
 * Abort every in-flight subagent session spawned from the current transcript.
 * Main-session abort alone does not stop delegated child runs on the Gateway.
 */
export async function abortPendingChildDelegations(
  messages: RawMessage[],
  rpc: GatewayRpc,
  processingSessionKeys: readonly string[] = [],
): Promise<void> {
  const toAbort = collectChildSessionsToAbort(messages, processingSessionKeys);
  if (toAbort.size === 0) return;

  await Promise.allSettled(
    [...toAbort.entries()].map(async ([childSessionKey, runId]) => {
      persistUserAbortedSession(childSessionKey, runId);
      try {
        await rpc(
          'sessions.abort',
          {
            key: childSessionKey,
            ...(runId ? { runId } : {}),
          },
          10_000,
        );
      } catch {
        // Child may already be idle; keep persisted abort flag.
      }
    }),
  );
}
