/**
 * Normalize execution report fields before backend upload.
 * Used by schedule (cron) reporting where transcript model ids differ from
 * renderer session model refs (e.g. "auto" vs "ly-auto/auto").
 */

/** Build backend-facing modelId as provider/model when possible. */
export function resolveExecutionReportModelId(
  model: string | undefined,
  provider: string | undefined,
  fallbackModelRef?: string,
): string {
  const trimmedModel = (model ?? '').trim();
  const trimmedProvider = (provider ?? '').trim();
  const fallback = (fallbackModelRef ?? '').trim();

  if (trimmedModel.includes('/')) {
    return trimmedModel;
  }

  if (trimmedProvider && trimmedModel) {
    return `${trimmedProvider}/${trimmedModel}`;
  }

  if (trimmedModel && fallback) {
    const fallbackModelId = fallback.includes('/')
      ? fallback.slice(fallback.indexOf('/') + 1).trim()
      : fallback;
    if (fallbackModelId === trimmedModel) {
      return fallback;
    }
    if (trimmedModel === 'auto' && fallback.includes('/')) {
      return fallback;
    }
  }

  if (trimmedModel) return trimmedModel;
  if (fallback) return fallback;
  return 'unknown';
}

/** Keep first_response_ms within the measured turn window. */
export function clampExecutionFirstResponseMs(
  firstResponseMs: number | undefined,
  startedAtMs: number,
  endedAtMs: number,
): number | undefined {
  if (firstResponseMs == null || !Number.isFinite(firstResponseMs)) {
    return undefined;
  }
  const normalized = Math.max(0, Math.floor(firstResponseMs));
  const durationMs = Math.max(0, Math.floor(endedAtMs - startedAtMs));
  if (durationMs === 0) return normalized;
  return Math.min(normalized, durationMs);
}
