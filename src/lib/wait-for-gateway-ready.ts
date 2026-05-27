import { useGatewayStore } from '@/stores/gateway';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isGatewayReadyNow(): boolean {
  const { status } = useGatewayStore.getState();
  return status.state === 'running' && status.gatewayReady === true;
}

/**
 * Wait until Gateway reports running + ready (e.g. after model switch restart).
 */
export async function waitForGatewayReady(options?: {
  timeoutMs?: number;
  settleMs?: number;
}): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 90_000;
  const settleMs = options?.settleMs ?? 400;

  if (isGatewayReadyNow()) {
    await delay(settleMs);
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const startedAt = Date.now();
    let settled = false;

    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      unsub();
      clearInterval(interval);
      if (ok) {
        void delay(settleMs).then(resolve);
      } else {
        reject(new Error('Gateway ready timeout'));
      }
    };

    const check = () => {
      if (isGatewayReadyNow()) {
        finish(true);
      } else if (Date.now() - startedAt > timeoutMs) {
        finish(false);
      }
    };

    const unsub = useGatewayStore.subscribe(check);
    const interval = setInterval(check, 250);
    check();
  });
}
