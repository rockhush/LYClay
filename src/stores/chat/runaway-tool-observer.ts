import type {
  AttachedFileMeta,
  ContentBlock,
  RawMessage,
  RunawayToolObservation,
  RunawayToolRiskState,
  TaskWorkflowKind,
  ToolStatus,
} from './types';
import {
  buildConvergenceDirective,
  shouldUpgradeConvergenceDirective,
} from './task-convergence-strategy';

type PendingAttachment = Pick<AttachedFileMeta, 'fileName' | 'mimeType' | 'fileSize'>;

const MAX_RECENT_ITEMS = 24;
const MAX_SEEN_KEYS = 160;

const SPREADSHEET_EXTENSIONS = new Set(['xlsx', 'xls', 'xlsm', 'xlsb', 'ods', 'csv', 'tsv']);
const WORD_EXTENSIONS = new Set(['doc', 'docx', 'rtf']);
const PRESENTATION_EXTENSIONS = new Set(['ppt', 'pptx', 'odp']);
const DATA_EXTENSIONS = new Set(['json', 'jsonl', 'parquet', 'ndjson', 'xml', 'yaml', 'yml']);

function lower(value: unknown): string {
  return String(value ?? '').toLowerCase();
}

function getExtension(fileName: string): string {
  const match = fileName.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] ?? '';
}

function hasAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}

function classifyByFile(fileName: string, mimeType: string): TaskWorkflowKind | null {
  const ext = getExtension(fileName);
  const mime = lower(mimeType);
  if (SPREADSHEET_EXTENSIONS.has(ext) || hasAny(mime, ['spreadsheet', 'excel', 'csv', 'tab-separated-values'])) {
    return 'spreadsheet';
  }
  if (ext === 'pdf' || mime.includes('pdf')) return 'pdf';
  if (WORD_EXTENSIONS.has(ext) || hasAny(mime, ['wordprocessingml', 'msword', 'rtf'])) return 'word';
  if (PRESENTATION_EXTENSIONS.has(ext) || hasAny(mime, ['presentationml', 'powerpoint'])) return 'presentation';
  if (DATA_EXTENSIONS.has(ext) || hasAny(mime, ['json', 'parquet', 'xml', 'yaml'])) return 'data-analysis';
  return null;
}

export function detectTaskWorkflowKind(
  text: string,
  attachments: PendingAttachment[] = [],
): TaskWorkflowKind {
  const fileKinds = attachments
    .map((attachment) => classifyByFile(attachment.fileName, attachment.mimeType))
    .filter((kind): kind is TaskWorkflowKind => Boolean(kind));

  if (fileKinds.length > 1) return 'batch-files';
  if (fileKinds.length === 1) return fileKinds[0];

  const normalized = lower(text);
  if (/\.(xlsx|xls|xlsm|xlsb|ods|csv|tsv)\b/.test(normalized)
    || hasAny(normalized, ['excel', 'spreadsheet', 'sheet', 'workbook', 'csv', '表格', '电子表格'])) {
    return 'spreadsheet';
  }
  if (/\.(pdf)\b/.test(normalized) || hasAny(normalized, ['pdf', '文档解析'])) return 'pdf';
  if (/\.(docx?|rtf)\b/.test(normalized) || hasAny(normalized, ['word', 'docx', '合同', '文档'])) return 'word';
  if (/\.(pptx?|odp)\b/.test(normalized) || hasAny(normalized, ['ppt', 'powerpoint', 'slides', '演示文稿'])) {
    return 'presentation';
  }
  if (/\.(jsonl?|parquet|ndjson|xml|ya?ml)\b/.test(normalized)
    || hasAny(normalized, ['数据分析', 'data analysis', 'dataset', '数据集'])) {
    return 'data-analysis';
  }
  return 'general';
}

export function createRunawayToolObservation(options: {
  sessionKey: string;
  runId?: string | null;
  taskKind: TaskWorkflowKind;
  initialStrategyInjected?: boolean;
  now?: number;
}): RunawayToolObservation {
  const now = options.now ?? Date.now();
  return {
    runId: options.runId ?? null,
    sessionKey: options.sessionKey,
    taskKind: options.taskKind,
    startedAt: now,
    updatedAt: now,
    toolCallCount: 0,
    toolResultCount: 0,
    writeExecPairCount: 0,
    repeatedExecCommandCount: 0,
    repeatedWriteTargetCount: 0,
    lastToolCallAt: null,
    lastToolResultAt: null,
    lastVisibleProgressAt: null,
    lastFinalAssistantAt: null,
    pendingFinal: false,
    riskState: 'normal',
    riskReasons: [],
    convergenceDirectiveLevel: 'none',
    convergenceDirective: null,
    convergenceDirectiveUpdatedAt: null,
    initialStrategyInjected: Boolean(options.initialStrategyInjected),
    seenToolCallKeys: [],
    seenToolResultKeys: [],
    recentToolNames: [],
    recentExecCommands: [],
    recentWriteTargets: [],
  };
}

export function bindRunIdToObservation(
  observation: RunawayToolObservation | null,
  runId: string,
  now = Date.now(),
): RunawayToolObservation | null {
  if (!observation || observation.runId === runId) return observation;
  return { ...observation, runId, updatedAt: now };
}

function boundedPush(values: string[], value: string, limit = MAX_RECENT_ITEMS): string[] {
  return [...values, value].slice(-limit);
}

function boundedUniquePush(values: string[], value: string, limit = MAX_SEEN_KEYS): string[] {
  if (values.includes(value)) return values;
  return [...values, value].slice(-limit);
}

function parseToolArgs(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

type ToolCallDetail = {
  key: string;
  name: string;
  args: Record<string, unknown>;
};

function extractToolCallDetails(message: unknown): ToolCallDetail[] {
  if (!message || typeof message !== 'object') return [];
  const msg = message as RawMessage & {
    tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }>;
  };
  const details: ToolCallDetail[] = [];

  if (Array.isArray(msg.content)) {
    for (const block of msg.content as ContentBlock[]) {
      if (block.type !== 'tool_use' && block.type !== 'toolCall') continue;
      const name = String(block.name || '').trim();
      if (!name) continue;
      const id = String(block.id || '');
      details.push({
        key: id || `block:${name}:${details.length}`,
        name,
        args: parseToolArgs(block.input ?? block.arguments),
      });
    }
  }

  if (Array.isArray(msg.tool_calls)) {
    for (const toolCall of msg.tool_calls) {
      const name = String(toolCall.function?.name || '').trim();
      if (!name) continue;
      const id = String(toolCall.id || '');
      details.push({
        key: id || `openai:${name}:${details.length}`,
        name,
        args: parseToolArgs(toolCall.function?.arguments),
      });
    }
  }

  return details;
}

function hasVisibleAssistantProgress(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  const msg = message as RawMessage;
  if (msg.role !== 'assistant') return false;
  if (typeof msg.content === 'string') return msg.content.trim().length > 0;
  if (!Array.isArray(msg.content)) return false;
  return (msg.content as ContentBlock[]).some((block) => block.type === 'text' && String(block.text ?? '').trim());
}

function extractToolResultKey(update: ToolStatus, index: number): string {
  return update.toolCallId || update.id || `${update.name}:${update.status}:${index}`;
}

function normalizeExecCommand(args: Record<string, unknown>): string | null {
  const command = String(args.command ?? args.cmd ?? '').trim();
  if (!command) return null;
  return command.toLowerCase().replace(/\s+/g, ' ').slice(0, 240);
}

function normalizeWriteTarget(args: Record<string, unknown>): string | null {
  const raw = String(args.file_path ?? args.path ?? args.filename ?? '').trim();
  if (!raw) return null;
  const base = raw.split(/[\\/]/).pop() || raw;
  return base.toLowerCase().replace(/\d+/g, '#').slice(0, 120);
}

function calculateRisk(next: RunawayToolObservation): Pick<RunawayToolObservation, 'riskState' | 'riskReasons'> {
  const reasons: string[] = [];
  let riskState: RunawayToolRiskState = 'normal';

  if (next.toolCallCount >= 15) {
    riskState = 'needs_convergence';
    reasons.push(`tool_calls>=15 (${next.toolCallCount})`);
  }
  if (next.writeExecPairCount >= 3 || next.repeatedExecCommandCount >= 3 || next.repeatedWriteTargetCount >= 3) {
    riskState = 'debug_loop';
    reasons.push('repeated write/exec debug pattern');
  }
  if (next.toolCallCount >= 25) {
    riskState = 'tool_heavy';
    reasons.push(`tool_calls>=25 (${next.toolCallCount})`);
  }
  if (next.toolCallCount >= 35) {
    riskState = 'must_summarize';
    reasons.push(`tool_calls>=35 (${next.toolCallCount})`);
  }
  if (next.toolCallCount >= 45) {
    riskState = 'needs_pause';
    reasons.push(`tool_calls>=45 (${next.toolCallCount})`);
  }

  if (next.taskKind !== 'general' && next.toolCallCount >= 10) {
    reasons.push(`document/data task: ${next.taskKind}`);
  }

  return { riskState, riskReasons: reasons };
}

function applyConvergenceDirective(next: RunawayToolObservation, now: number): RunawayToolObservation {
  const { level, directive } = buildConvergenceDirective(next);
  if (!directive || !shouldUpgradeConvergenceDirective(next.convergenceDirectiveLevel, level)) {
    return next;
  }
  console.info('[chat.tool-loop-observer] convergence directive prepared', {
    sessionKey: next.sessionKey,
    runId: next.runId,
    taskKind: next.taskKind,
    level,
    riskState: next.riskState,
    toolCallCount: next.toolCallCount,
  });
  return {
    ...next,
    convergenceDirectiveLevel: level,
    convergenceDirective: directive,
    convergenceDirectiveUpdatedAt: now,
  };
}

function logRiskTransition(prev: RunawayToolObservation, next: RunawayToolObservation): void {
  if (prev.riskState === next.riskState) return;
  console.info('[chat.tool-loop-observer] risk state changed', {
    sessionKey: next.sessionKey,
    runId: next.runId,
    taskKind: next.taskKind,
    previous: prev.riskState,
    current: next.riskState,
    toolCallCount: next.toolCallCount,
    toolResultCount: next.toolResultCount,
    reasons: next.riskReasons,
  });
}

export function observeRunawayToolEvent(options: {
  observation: RunawayToolObservation | null;
  event: Record<string, unknown>;
  resolvedState: string;
  runId: string;
  sessionKey: string;
  toolUpdates: ToolStatus[];
  now?: number;
}): RunawayToolObservation | null {
  const { event, resolvedState, runId, sessionKey, toolUpdates } = options;
  const now = options.now ?? Date.now();
  let prev = options.observation;

  if (!prev && resolvedState === 'started') {
    prev = createRunawayToolObservation({
      sessionKey,
      runId: runId || null,
      taskKind: 'general',
      now,
    });
  }
  if (!prev) return null;
  if (prev.sessionKey !== sessionKey) return prev;

  let next: RunawayToolObservation = {
    ...prev,
    runId: prev.runId || runId || null,
    updatedAt: now,
    pendingFinal: prev.pendingFinal || resolvedState === 'final',
  };

  if (hasVisibleAssistantProgress(event.message)) {
    next.lastVisibleProgressAt = now;
    if (resolvedState === 'final') {
      next.lastFinalAssistantAt = now;
      next.pendingFinal = false;
    }
  }

  for (const detail of extractToolCallDetails(event.message)) {
    const key = `${runId || next.runId || 'run'}:call:${detail.key}`;
    if (next.seenToolCallKeys.includes(key)) continue;

    const previousToolName = next.recentToolNames[next.recentToolNames.length - 1];
    next.seenToolCallKeys = boundedUniquePush(next.seenToolCallKeys, key);
    next.toolCallCount += 1;
    next.lastToolCallAt = now;
    next.recentToolNames = boundedPush(next.recentToolNames, detail.name);

    if (previousToolName === 'write' && detail.name === 'exec') {
      next.writeExecPairCount += 1;
    }

    if (detail.name === 'exec') {
      const command = normalizeExecCommand(detail.args);
      if (command) {
        if (next.recentExecCommands.includes(command)) next.repeatedExecCommandCount += 1;
        next.recentExecCommands = boundedPush(next.recentExecCommands, command);
      }
    }

    if (detail.name === 'write') {
      const target = normalizeWriteTarget(detail.args);
      if (target) {
        if (next.recentWriteTargets.includes(target)) next.repeatedWriteTargetCount += 1;
        next.recentWriteTargets = boundedPush(next.recentWriteTargets, target);
      }
    }
  }

  toolUpdates.forEach((update, index) => {
    if (update.status === 'running') return;
    const key = `${runId || next.runId || 'run'}:result:${extractToolResultKey(update, index)}`;
    if (next.seenToolResultKeys.includes(key)) return;
    next.seenToolResultKeys = boundedUniquePush(next.seenToolResultKeys, key);
    next.toolResultCount += 1;
    next.lastToolResultAt = now;
  });

  next = { ...next, ...calculateRisk(next) };
  next = applyConvergenceDirective(next, now);
  logRiskTransition(prev, next);
  return next;
}
