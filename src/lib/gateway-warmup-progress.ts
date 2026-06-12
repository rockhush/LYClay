import type { GatewayStatus } from '@/types/gateway';

/**
 * Same curve as the post-login warmup screen — used for the chat “first response” bar
 * so both feel consistent (left-to-right fill, no scrolling segment).
 */
export function estimateGatewayWarmupProgress(
  status: GatewayStatus,
  elapsedSeconds: number,
): number {
  if (status.warmupStatus === 'ready') return 100;
  if (status.warmupStatus === 'failed') return 100;
  if (status.warmupStatus === 'warming') return Math.min(95, 55 + elapsedSeconds * 4);
  if (status.state === 'running' && status.gatewayReady) return Math.min(70, 40 + elapsedSeconds * 4);
  if (status.state === 'running') return Math.min(55, 30 + elapsedSeconds * 3);
  if (status.state === 'starting') return Math.min(45, 15 + elapsedSeconds * 2);
  return Math.min(35, 12 + elapsedSeconds * 2);
}
