export type TrajectoryUsageSupplement = {
  runId: string;
  timestamp: string;
  model?: string;
  provider?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
};

function estimateTokens(text: string): number {
  if (!text) return 0;

  let count = 0;
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code >= 0x4e00 && code <= 0x9fff) {
      count += 0.5;
    } else if (/\s/.test(char)) {
      count += 0.1;
    } else {
      count += 0.25;
    }
  }
  return Math.ceil(count);
}

function estimateContentTokens(content: unknown): number {
  if (!content) return 0;
  if (typeof content === 'string') return estimateTokens(content);
  if (Array.isArray(content)) {
    return content.reduce((sum, item) => sum + estimateContentTokens(item), 0);
  }
  if (typeof content === 'object') {
    const block = content as Record<string, unknown>;
    if (typeof block.text === 'string') return estimateTokens(block.text);
    if (typeof block.thinking === 'string') return estimateTokens(block.thinking);
    if (block.content !== undefined) return estimateContentTokens(block.content);
    return estimateTokens(JSON.stringify(block));
  }
  return estimateTokens(String(content));
}

function estimateSystemPromptTokens(systemPrompt: unknown): number {
  if (typeof systemPrompt === 'string') {
    return estimateTokens(systemPrompt);
  }
  if (systemPrompt && typeof systemPrompt === 'object') {
    const record = systemPrompt as Record<string, unknown>;
    if (typeof record.originalChars === 'number' && Number.isFinite(record.originalChars)) {
      return Math.ceil(record.originalChars / 4);
    }
    if (typeof record.truncated === 'boolean' && typeof record.limitChars === 'number') {
      return Math.ceil(record.limitChars / 4);
    }
  }
  return 0;
}

function estimatePromptSubmittedInput(data: Record<string, unknown>): number {
  let total = estimateSystemPromptTokens(data.systemPrompt);
  if (typeof data.prompt === 'string') {
    total += estimateTokens(data.prompt);
  }
  if (Array.isArray(data.messages)) {
    for (const message of data.messages) {
      if (!message || typeof message !== 'object') continue;
      const record = message as Record<string, unknown>;
      total += estimateContentTokens(record.content) + 4;
    }
  }
  return total;
}

function firstUsageNumber(usage: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function usageFromShape(usage: unknown): TrajectoryUsageSupplement | null {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const shape = usage as Record<string, unknown>;
  const inputTokens = firstUsageNumber(shape, ['input', 'promptTokens', 'prompt_tokens', 'input_tokens']) ?? 0;
  const outputTokens = firstUsageNumber(shape, ['output', 'completionTokens', 'completion_tokens', 'output_tokens']) ?? 0;
  const cacheReadTokens = firstUsageNumber(shape, ['cacheRead', 'cache_read', 'cache_read_tokens'])
    ?? (() => {
      const details = shape.prompt_tokens_details;
      if (!details || typeof details !== 'object' || Array.isArray(details)) return undefined;
      return firstUsageNumber(details as Record<string, unknown>, ['cached_tokens', 'cachedTokens', 'cache_read']);
    })()
    ?? 0;
  const cacheWriteTokens = firstUsageNumber(shape, ['cacheWrite', 'cache_write', 'cache_write_tokens']) ?? 0;
  const explicitTotal = firstUsageNumber(shape, ['total', 'totalTokens', 'total_tokens']) ?? 0;
  const totalTokens = explicitTotal > 0
    ? explicitTotal
    : inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  if (totalTokens <= 0) return null;
  return {
    runId: '',
    timestamp: '',
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
  };
}

export function parseTrajectoryUsageSupplements(content: string): TrajectoryUsageSupplement[] {
  const inputByRunId = new Map<string, number>();
  const completedByRunId = new Map<string, {
    timestamp: string;
    model?: string;
    provider?: string;
    usage: TrajectoryUsageSupplement | null;
    outputEstimate: number;
  }>();

  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = typeof parsed.type === 'string' ? parsed.type : '';
    const runId = typeof parsed.runId === 'string' ? parsed.runId : '';
    const timestamp = typeof parsed.ts === 'string' ? parsed.ts : '';
    const data = parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data)
      ? parsed.data as Record<string, unknown>
      : null;
    if (!runId || !data) continue;

    if (type === 'prompt.submitted' || type === 'context.compiled') {
      const inputEstimate = estimatePromptSubmittedInput(data);
      if (inputEstimate > 0) {
        inputByRunId.set(runId, Math.max(inputByRunId.get(runId) ?? 0, inputEstimate));
      }
      continue;
    }

    if (type !== 'model.completed') continue;

    const usage = usageFromShape(data.usage) ?? usageFromShape(
      data.promptCache && typeof data.promptCache === 'object'
        ? (data.promptCache as Record<string, unknown>).lastCallUsage
        : undefined,
    );

    const assistantTexts = Array.isArray(data.assistantTexts)
      ? data.assistantTexts.filter((item): item is string => typeof item === 'string')
      : [];
    const outputEstimate = assistantTexts.length > 0
      ? estimateTokens(assistantTexts.join('\n'))
      : estimateTokens(typeof data.finalPromptText === 'string' ? data.finalPromptText : '');

    completedByRunId.set(runId, {
      timestamp,
      model: typeof parsed.modelId === 'string' ? parsed.modelId : undefined,
      provider: typeof parsed.provider === 'string' ? parsed.provider : undefined,
      usage,
      outputEstimate,
    });
  }

  const supplements: TrajectoryUsageSupplement[] = [];
  for (const [runId, completed] of completedByRunId.entries()) {
    const inputTokens = completed.usage?.inputTokens
      ?? inputByRunId.get(runId)
      ?? 0;
    const outputTokens = completed.usage?.outputTokens
      ?? (completed.outputEstimate > 0 ? completed.outputEstimate : 0);
    const cacheReadTokens = completed.usage?.cacheReadTokens ?? 0;
    const cacheWriteTokens = completed.usage?.cacheWriteTokens ?? 0;
    const totalTokens = completed.usage?.totalTokens
      ?? (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens);

    if (totalTokens <= 0) continue;

    supplements.push({
      runId,
      timestamp: completed.timestamp,
      model: completed.model,
      provider: completed.provider,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalTokens,
    });
  }

  supplements.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  return supplements;
}

export function findTrajectoryUsageSupplement(
  supplements: TrajectoryUsageSupplement[],
  timestamp: string,
): TrajectoryUsageSupplement | undefined {
  const targetMs = Date.parse(timestamp);
  if (!Number.isFinite(targetMs)) return undefined;

  let best: TrajectoryUsageSupplement | undefined;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const supplement of supplements) {
    const diff = Math.abs(Date.parse(supplement.timestamp) - targetMs);
    if (diff <= 15_000 && diff < bestDiff) {
      best = supplement;
      bestDiff = diff;
    }
  }
  return best;
}
