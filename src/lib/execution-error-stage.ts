/**
 * Classify runtime failures for execution reporting (`error_stage`).
 */

export type ExecutionErrorStage = 'client' | 'gateway' | 'model';

const GATEWAY_PATTERNS = [
  /gateway/i,
  /websocket/i,
  /ws\b/i,
  /connect/i,
  /timeout/i,
  /timed out/i,
  /unreachable/i,
  /econnrefused/i,
  /enetunreach/i,
  /network/i,
  /127\.0\.0\.1:18789/,
  /session\.abort/i,
];

const MODEL_PATTERNS = [
  /model/i,
  /provider/i,
  /api key/i,
  /authentication/i,
  /unauthorized/i,
  /rate limit/i,
  /429\b/,
  /quota/i,
  /token/i,
  /context length/i,
  /prompt/i,
  /openai/i,
  /anthropic/i,
  /bedrock/i,
];

export function classifyExecutionErrorStage(
  errorMessage: string | null | undefined,
  options?: { cancelled?: boolean },
): ExecutionErrorStage {
  if (options?.cancelled) return 'client';
  const text = (errorMessage ?? '').trim();
  if (!text) return 'client';
  const lower = text.toLowerCase();
  if (MODEL_PATTERNS.some((pattern) => pattern.test(lower))) return 'model';
  if (GATEWAY_PATTERNS.some((pattern) => pattern.test(lower))) return 'gateway';
  return 'client';
}
