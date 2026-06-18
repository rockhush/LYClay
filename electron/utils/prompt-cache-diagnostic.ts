import { createHash } from 'node:crypto';

export type TrajectoryTurnRecord = {
  runId: string;
  timestamp: string;
  type: 'context.compiled' | 'prompt.submitted' | 'model.completed';
  model?: string;
  provider?: string;
  systemPromptHash?: string;
  systemPromptLength?: number;
  messagesCount?: number;
  messagesFingerprint?: string;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
};

export type PromptPrefixDiff = {
  turnIndex: number;
  previousRunId: string;
  currentRunId: string;
  systemPromptChanged: boolean;
  messagesPrefixAppendOnly: boolean;
  prefixBreakReason?: string;
};

export type PromptCacheDiagnosticReport = {
  sessionFile: string;
  turns: TrajectoryTurnRecord[];
  prefixDiffs: PromptPrefixDiff[];
  summary: {
    turnCount: number;
    cacheHitTurns: number;
    systemPromptDriftTurns: number;
    messagesPrefixBreakTurns: number;
  };
};

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function normalizeSystemPrompt(systemPrompt: unknown): string {
  if (typeof systemPrompt === 'string') return systemPrompt;
  if (systemPrompt && typeof systemPrompt === 'object') {
    return JSON.stringify(systemPrompt);
  }
  return '';
}

function fingerprintMessages(messages: unknown): string {
  if (!Array.isArray(messages)) return '';
  const parts: string[] = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const record = message as Record<string, unknown>;
    const role = typeof record.role === 'string' ? record.role : 'unknown';
    const content = typeof record.content === 'string'
      ? record.content
      : JSON.stringify(record.content ?? '');
    parts.push(`${role}:${content}`);
  }
  return parts.join('\n---\n');
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

function parseTrajectoryLine(parsed: Record<string, unknown>): TrajectoryTurnRecord | null {
  const type = typeof parsed.type === 'string' ? parsed.type : '';
  if (type !== 'context.compiled' && type !== 'prompt.submitted' && type !== 'model.completed') {
    return null;
  }

  const runId = typeof parsed.runId === 'string' ? parsed.runId : '';
  const timestamp = typeof parsed.ts === 'string' ? parsed.ts : '';
  const data = parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data)
    ? parsed.data as Record<string, unknown>
    : null;
  if (!runId || !data) return null;

  const record: TrajectoryTurnRecord = {
    runId,
    timestamp,
    type,
    model: typeof parsed.modelId === 'string' ? parsed.modelId : undefined,
    provider: typeof parsed.provider === 'string' ? parsed.provider : undefined,
  };

  if (type === 'context.compiled' || type === 'prompt.submitted') {
    const systemPrompt = normalizeSystemPrompt(data.systemPrompt);
    record.systemPromptHash = hashText(systemPrompt);
    record.systemPromptLength = systemPrompt.length;
    record.messagesCount = Array.isArray(data.messages) ? data.messages.length : undefined;
    record.messagesFingerprint = fingerprintMessages(data.messages);
    return record;
  }

  const usage = data.usage && typeof data.usage === 'object' && !Array.isArray(data.usage)
    ? data.usage as Record<string, unknown>
    : null;
  if (usage) {
    const details = usage.prompt_tokens_details;
    const nestedCacheRead = details && typeof details === 'object' && !Array.isArray(details)
      ? firstUsageNumber(details as Record<string, unknown>, ['cached_tokens', 'cachedTokens', 'cache_read'])
      : undefined;
    record.cacheReadTokens = firstUsageNumber(usage, ['cacheRead', 'cache_read', 'cache_read_tokens'])
      ?? nestedCacheRead
      ?? 0;
    record.cacheWriteTokens = firstUsageNumber(usage, ['cacheWrite', 'cache_write', 'cache_write_tokens']) ?? 0;
    record.inputTokens = firstUsageNumber(usage, ['input', 'promptTokens', 'prompt_tokens', 'input_tokens']) ?? 0;
    record.outputTokens = firstUsageNumber(usage, ['output', 'completionTokens', 'completion_tokens', 'output_tokens']) ?? 0;
  }

  return record;
}

export function parseTrajectoryTurns(content: string): TrajectoryTurnRecord[] {
  const byRunId = new Map<string, TrajectoryTurnRecord>();

  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const record = parseTrajectoryLine(parsed);
    if (!record) continue;

    const existing = byRunId.get(record.runId);
    if (!existing) {
      byRunId.set(record.runId, record);
      continue;
    }

    byRunId.set(record.runId, {
      ...existing,
      ...record,
      systemPromptHash: record.systemPromptHash ?? existing.systemPromptHash,
      systemPromptLength: record.systemPromptLength ?? existing.systemPromptLength,
      messagesCount: record.messagesCount ?? existing.messagesCount,
      messagesFingerprint: record.messagesFingerprint ?? existing.messagesFingerprint,
      cacheReadTokens: record.cacheReadTokens ?? existing.cacheReadTokens,
      cacheWriteTokens: record.cacheWriteTokens ?? existing.cacheWriteTokens,
      inputTokens: record.inputTokens ?? existing.inputTokens,
      outputTokens: record.outputTokens ?? existing.outputTokens,
    });
  }

  return Array.from(byRunId.values()).sort(
    (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
  );
}

export function comparePromptPrefixes(turns: TrajectoryTurnRecord[]): PromptPrefixDiff[] {
  const compiledTurns = turns.filter((turn) => turn.messagesFingerprint !== undefined);
  const diffs: PromptPrefixDiff[] = [];

  for (let index = 1; index < compiledTurns.length; index += 1) {
    const previous = compiledTurns[index - 1]!;
    const current = compiledTurns[index]!;
    const previousFingerprint = previous.messagesFingerprint ?? '';
    const currentFingerprint = current.messagesFingerprint ?? '';

    let messagesPrefixAppendOnly = currentFingerprint.startsWith(previousFingerprint);
    let prefixBreakReason: string | undefined;

    if (!messagesPrefixAppendOnly) {
      if (previousFingerprint.length === 0) {
        messagesPrefixAppendOnly = true;
      } else if (currentFingerprint.length < previousFingerprint.length) {
        prefixBreakReason = 'messages shrank (compaction or rewrite)';
      } else if (currentFingerprint.slice(0, previousFingerprint.length) !== previousFingerprint) {
        prefixBreakReason = 'middle prefix changed (non append-only history)';
      } else {
        prefixBreakReason = 'messages fingerprint diverged';
      }
    }

    const systemPromptChanged = Boolean(
      previous.systemPromptHash
      && current.systemPromptHash
      && previous.systemPromptHash !== current.systemPromptHash,
    );

    diffs.push({
      turnIndex: index + 1,
      previousRunId: previous.runId,
      currentRunId: current.runId,
      systemPromptChanged,
      messagesPrefixAppendOnly,
      prefixBreakReason: messagesPrefixAppendOnly ? undefined : prefixBreakReason,
    });
  }

  return diffs;
}

export function buildPromptCacheDiagnosticReport(
  sessionFile: string,
  content: string,
): PromptCacheDiagnosticReport {
  const turns = parseTrajectoryTurns(content);
  const prefixDiffs = comparePromptPrefixes(turns);

  const cacheHitTurns = turns.filter((turn) => (turn.cacheReadTokens ?? 0) > 0).length;
  const systemPromptDriftTurns = prefixDiffs.filter((diff) => diff.systemPromptChanged).length;
  const messagesPrefixBreakTurns = prefixDiffs.filter((diff) => !diff.messagesPrefixAppendOnly).length;

  return {
    sessionFile,
    turns,
    prefixDiffs,
    summary: {
      turnCount: turns.length,
      cacheHitTurns,
      systemPromptDriftTurns,
      messagesPrefixBreakTurns,
    },
  };
}

export function formatPromptCacheDiagnosticReport(report: PromptCacheDiagnosticReport): string {
  const lines: string[] = [
    `Session: ${report.sessionFile}`,
    `Turns: ${report.summary.turnCount}, cacheRead>0: ${report.summary.cacheHitTurns}`,
    `System prompt drift between turns: ${report.summary.systemPromptDriftTurns}`,
    `Messages prefix breaks: ${report.summary.messagesPrefixBreakTurns}`,
    '',
    'Turn timeline:',
  ];

  for (const [index, turn] of report.turns.entries()) {
    lines.push(
      [
        `#${index + 1}`,
        turn.runId,
        turn.type,
        turn.model ?? '-',
        turn.systemPromptHash ? `sys=${turn.systemPromptHash}` : '',
        turn.messagesCount !== undefined ? `msgs=${turn.messagesCount}` : '',
        turn.cacheReadTokens !== undefined ? `cacheRead=${turn.cacheReadTokens}` : '',
        turn.cacheWriteTokens !== undefined ? `cacheWrite=${turn.cacheWriteTokens}` : '',
      ].filter(Boolean).join(' | '),
    );
  }

  if (report.prefixDiffs.length > 0) {
    lines.push('', 'Prefix diffs:');
    for (const diff of report.prefixDiffs) {
      lines.push(
        [
          `turn ${diff.turnIndex}`,
          diff.systemPromptChanged ? 'SYSTEM_PROMPT_CHANGED' : 'system_ok',
          diff.messagesPrefixAppendOnly ? 'messages_append_only' : `messages_break:${diff.prefixBreakReason}`,
        ].join(' | '),
      );
    }
  }

  return lines.join('\n');
}
