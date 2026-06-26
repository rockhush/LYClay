import { collectPendingChildDelegationBindings } from '@/lib/subagent-delegation';
import type { RawMessage } from './types';
import { persistUserAbortedSession } from './user-aborted-sessions';

type GatewayRpc = (
  method: string,
  params: Record<string, unknown>,
  timeoutMs?: number,
) => Promise<unknown>;

/**
 * Abort every in-flight subagent session spawned from the current transcript.
 * Main-session abort alone does not stop delegated child runs on the Gateway.
 */
export async function abortPendingChildDelegations(
  messages: RawMessage[],
  rpc: GatewayRpc,
): Promise<void> {
  const pending = collectPendingChildDelegationBindings(messages);
  if (pending.length === 0) return;

  await Promise.allSettled(
    pending.map(async (binding) => {
      persistUserAbortedSession(binding.childSessionKey, binding.runId);
      try {
        await rpc(
          'sessions.abort',
          {
            key: binding.childSessionKey,
            ...(binding.runId ? { runId: binding.runId } : {}),
          },
          10_000,
        );
      } catch {
        // Child may already be idle; keep persisted abort flag.
      }
    }),
  );
}
