import type {
  AttachedFileMeta,
  ContentBlock,
  GeneratedCodeFailureKind,
  GeneratedCodeValidationFailure,
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

type ToolCallDetail = {
  key: string;
  name: string;
  args: Record<string, unknown>;
};

type FailureClassification = {
  kind: GeneratedCodeFailureKind;
  path: string | null;
  language: string | null;
  message: string;
  commandFamily: string | null;
};

const MAX_RECENT_ITEMS = 24;
const MAX_SEEN_KEYS = 160;
const MAX_FAILURES = 16;
const MAX_FAILURE_MESSAGE = 360;

const SPREADSHEET_EXTENSIONS = new Set(['xlsx', 'xls', 'xlsm', 'xlsb', 'ods', 'csv', 'tsv']);
const WORD_EXTENSIONS = new Set(['doc', 'docx', 'rtf']);
const PRESENTATION_EXTENSIONS = new Set(['ppt', 'pptx', 'odp']);
const DATA_EXTENSIONS = new Set(['json', 'jsonl', 'parquet', 'ndjson', 'xml', 'yaml', 'yml']);
const GENERATED_CODE_EXTENSIONS = new Set(['py', 'js', 'ts', 'mjs', 'cjs', 'json', 'sh', 'ps1', 'bat', 'cmd']);
const SKILL_MUTATION_TOOLS = new Set(['write', 'edit', 'delete', 'remove', 'rm', 'move', 'rename', 'apply_patch']);

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
  if (/\b(create|edit|update|repair|fix|modify)\b.*\b(skill|plugin)\b/.test(normalized)) return 'general';
  if (/\.(pdf)\b/.test(normalized)) return 'pdf';
  if (/\.(docx?|rtf)\b/.test(normalized)) return 'word';
  if (/\.(pptx?|odp)\b/.test(normalized)) return 'presentation';
  if (/\.(jsonl?|parquet|ndjson|xml|ya?ml)\b/.test(normalized)) return 'data-analysis';
  if (/\.(xlsx|xls|xlsm|xlsb|ods|csv|tsv)\b/.test(normalized)
    || hasAny(normalized, ['excel', 'spreadsheet', 'sheet', 'workbook', 'csv', 'table'])) {
    return 'spreadsheet';
  }
  if (/\.(pdf)\b/.test(normalized) || hasAny(normalized, ['pdf'])) return 'pdf';
  if (/\.(docx?|rtf)\b/.test(normalized) || hasAny(normalized, ['word', 'docx', 'document'])) return 'word';
  if (/\.(pptx?|odp)\b/.test(normalized)
    || hasAny(normalized, ['ppt', 'powerpoint', 'slides', 'deck', 'presentation', 'report', 'doe'])) {
    return 'presentation';
  }
  if (/\.(jsonl?|parquet|ndjson|xml|ya?ml)\b/.test(normalized)
    || hasAny(normalized, ['data analysis', 'dataset', 'chart', 'plot', 'generated-report', 'analysis script'])) {
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
    repeatedDebugScriptCount: 0,
    repeatedOutputPatternCount: 0,
    structuralInspectionCount: 0,
    generatedCodeFailureCount: 0,
    sameGeneratedFileFailureCount: 0,
    sameCommandFamilyFailureCount: 0,
    skillSourceMutationBlockedCount: 0,
    pauseReason: null,
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
    injectedConvergenceDirectiveLevel: 'none',
    injectedConvergenceDirectiveAt: null,
    initialStrategyInjected: Boolean(options.initialStrategyInjected),
    seenToolCallKeys: [],
    seenToolResultKeys: [],
    recentToolNames: [],
    recentExecCommands: [],
    recentWriteTargets: [],
    recentDebugScriptTargets: [],
    recentOutputFingerprints: [],
    recentGeneratedFailurePaths: [],
    recentGeneratedFailureKinds: [],
    recentCommandFailureFamilies: [],
    generatedCodeValidationFailures: [],
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
  const raw = extractPathFromArgs(args);
  if (!raw) return null;
  const base = raw.split(/[\\/]/).pop() || raw;
  return base.toLowerCase().replace(/\d+/g, '#').slice(0, 120);
}

function extractPathFromArgs(args: Record<string, unknown>): string | null {
  const raw = String(args.file_path ?? args.filePath ?? args.path ?? args.filename ?? args.target ?? '').trim();
  return raw || null;
}

function normalizePathFingerprint(path: string | null): string | null {
  if (!path) return null;
  return path.replace(/\\/g, '/').toLowerCase().replace(/\d+/g, '#').slice(-180);
}

function extractMessageText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const content = (message as RawMessage).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => {
    if (!block || typeof block !== 'object') return '';
    const record = block as Record<string, unknown>;
    const nested = record.content;
    if (Array.isArray(nested)) {
      return nested.map((item) => {
        if (!item || typeof item !== 'object') return String(item ?? '');
        return String((item as Record<string, unknown>).text ?? (item as Record<string, unknown>).content ?? '');
      }).join('\n');
    }
    return String(record.text ?? record.content ?? '');
  }).filter(Boolean).join('\n');
}

function normalizeDebugScriptTarget(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.toLowerCase().replace(/\\/g, '/');
  const match = normalized.match(/(?:^|\/)((?:vmi[_-]?(?:debug|check)|tmp|debug|check|inspect|runner|generate|report|doe)[a-z0-9_#-]*\.py)\b/)
    ?? normalized.match(/\bpython(?:\.exe)?\s+(?:[^\s"']+[\/])?((?:vmi[_-]?(?:debug|check)|tmp|debug|check|inspect|runner|generate|report|doe)[a-z0-9_#-]*\.py)\b/);
  if (!match) return null;
  return match[1].replace(/\d+/g, '#');
}

function extractDebugScriptTarget(name: string, args: Record<string, unknown>): string | null {
  const command = String(args.command ?? args.cmd ?? '').trim();
  const writeTarget = normalizeWriteTarget(args);
  if (['write', 'edit'].includes(name.toLowerCase())) return normalizeDebugScriptTarget(writeTarget);
  if (name.toLowerCase() === 'exec') return normalizeDebugScriptTarget(command);
  return null;
}

function isStructuralInspectionTool(name: string, args: Record<string, unknown>): boolean {
  const lowerName = name.toLowerCase();
  if (['read', 'grep', 'search', 'find', 'glob', 'list', 'ls'].includes(lowerName)) return true;
  if (lowerName !== 'exec') return false;
  const command = normalizeExecCommand(args) ?? '';
  return /\b(dir|ls|find|rg|grep|head|tail)\b/.test(command)
    || (/\bpython\b/.test(command) && /\b(inspect|check|debug|preview|schema|sheet|sheets|columns|rows|head|sample)\b/.test(command));
}

function normalizeOutputFingerprint(message: unknown): string | null {
  const text = extractMessageText(message).toLowerCase().replace(/\r/g, '').trim();
  if (text.length < 24) return null;
  const rowLike = text.split('\n')
    .map((line) => line.trim())
    .filter((line) => /\b(row|col|column|sheet|empty|null|none|nan|syntaxerror|parsererror)\b/.test(line))
    .slice(0, 8);
  const basis = rowLike.length >= 2 ? rowLike.join('\n') : text.split('\n').filter(Boolean).slice(0, 6).join('\n');
  const compact = basis
    .replace(/[a-z]:\/[\w./-]+/g, '<path>')
    .replace(/\b\d{2,}\b/g, '#')
    .replace(/\s+/g, ' ')
    .slice(0, 220);
  return compact.length >= 24 ? compact : null;
}

function languageForPath(path: string | null): string | null {
  if (!path) return null;
  const ext = getExtension(path);
  if (ext === 'py') return 'python';
  if (['js', 'mjs', 'cjs'].includes(ext)) return 'javascript';
  if (ext === 'ts') return 'typescript';
  if (ext === 'json') return 'json';
  if (['sh', 'ps1', 'bat', 'cmd'].includes(ext)) return 'shell';
  return null;
}

function isGeneratedCodePath(path: string | null): boolean {
  return Boolean(path && GENERATED_CODE_EXTENSIONS.has(getExtension(path)));
}

function isSkillSourcePath(path: string | null): boolean {
  if (!path) return false;
  const normalized = path.replace(/\\/g, '/').toLowerCase();
  return normalized.includes('/.openclaw/skills/')
    || normalized.includes('/openclaw/skills/')
    || (normalized.includes('/plugins/cache/') && normalized.includes('/skills/'))
    || normalized.includes('/.codex/skills/')
    || normalized.includes('/codex/skills/');
}

function truncateDiagnostic(value: string): string {
  return value.replace(/\x00/g, '\\0').replace(/\s+/g, ' ').trim().slice(0, MAX_FAILURE_MESSAGE);
}

function extractPathFromText(text: string): string | null {
  const quoted = text.match(/['"]([a-zA-Z]:[\\/][^'"]+\.(?:py|js|ts|mjs|cjs|json|sh|ps1|bat|cmd))['"]/);
  if (quoted) return quoted[1];
  const bare = text.match(/\b([a-zA-Z]:[\\/][^\s:]+\.(?:py|js|ts|mjs|cjs|json|sh|ps1|bat|cmd))\b/);
  if (bare) return bare[1];
  const relative = text.match(/\b([\w./\\-]+\.(?:py|js|ts|mjs|cjs|json|sh|ps1|bat|cmd))\b/);
  return relative?.[1] ?? null;
}

function commandFamilyFor(command: string | null, kind: GeneratedCodeFailureKind): string | null {
  if (!command) return null;
  const compact = command.toLowerCase().replace(/\\/g, '/').replace(/\s+/g, ' ');
  const file = compact.match(/([^\s"']+\.(?:py|js|ts|mjs|cjs|json|sh|ps1|bat|cmd))\b/)?.[1]?.split('/').pop() ?? '';
  const runner = compact.match(/\b(node|python(?:\.exe)?|py|uv run python|pnpm|powershell|pwsh)\b/)?.[1] ?? 'shell';
  return `${kind}:${runner}:${file || compact.replace(/\d+/g, '#').slice(0, 80)}`;
}

function classifyToolCallFailure(detail: ToolCallDetail): FailureClassification | null {
  const name = detail.name.toLowerCase();
  const path = extractPathFromArgs(detail.args);
  if (SKILL_MUTATION_TOOLS.has(name) && isSkillSourcePath(path)) {
    return {
      kind: 'skill_source_readonly',
      path,
      language: languageForPath(path),
      message: 'Attempted to modify installed skill source during an ordinary task.',
      commandFamily: `skill_source:${normalizePathFingerprint(path) ?? 'unknown'}`,
    };
  }
  return null;
}

function classifyToolResultFailure(update: ToolStatus, eventMessage: unknown, lastCommand: string | null): FailureClassification | null {
  if (update.status !== 'error' && update.status !== 'completed') return null;
  const text = `${update.summary ?? ''}\n${extractMessageText(eventMessage)}`;
  const normalized = text.toLowerCase();
  const command = lastCommand ?? '';
  const path = extractPathFromText(text) ?? extractPathFromText(command);
  const language = languageForPath(path) ?? (normalized.includes('python') || /\.py\b/i.test(command) ? 'python' : null);

  if (/\.py\b/i.test(command) && /\bnode(?:\.exe)?\b/i.test(command)) {
    return {
      kind: 'wrong_interpreter',
      path,
      language: 'python',
      message: 'Python script was executed with Node.',
      commandFamily: commandFamilyFor(command, 'wrong_interpreter'),
    };
  }
  if (command.includes('&&') && /parsererror|invalidendofline|not a valid statement separator|&&/.test(normalized)) {
    return {
      kind: 'shell_operator_unsupported',
      path,
      language,
      message: 'Shell rejected && or an unsupported heredoc/operator form.',
      commandFamily: commandFamilyFor(command, 'shell_operator_unsupported'),
    };
  }
  if (normalized.includes('source code cannot contain null bytes') || normalized.includes('null byte')) {
    return {
      kind: 'generated_code_null_bytes',
      path,
      language,
      message: truncateDiagnostic(text),
      commandFamily: commandFamilyFor(command, 'generated_code_null_bytes'),
    };
  }
  if (normalized.includes('syntaxerror') && (language === 'python' || /\.py\b/i.test(text) || /python/i.test(command))) {
    return {
      kind: 'generated_python_syntax_error',
      path,
      language: 'python',
      message: truncateDiagnostic(text),
      commandFamily: commandFamilyFor(command, 'generated_python_syntax_error'),
    };
  }
  if (normalized.includes('json') && /parse|unexpected token|unexpected end/.test(normalized) && (language === 'json' || /\.json\b/i.test(text))) {
    return {
      kind: 'generated_json_parse_error',
      path,
      language: 'json',
      message: truncateDiagnostic(text),
      commandFamily: commandFamilyFor(command, 'generated_json_parse_error'),
    };
  }
  if (/old text|no match|could not find|failed to apply|patch failed/.test(normalized) && isGeneratedCodePath(path)) {
    return {
      kind: 'repeated_debug_loop',
      path,
      language,
      message: truncateDiagnostic(text),
      commandFamily: commandFamilyFor(command, 'repeated_debug_loop'),
    };
  }
  return null;
}

function recordGeneratedFailure(
  next: RunawayToolObservation,
  classification: FailureClassification,
  now: number,
): RunawayToolObservation {
  const pathKey = normalizePathFingerprint(classification.path);
  const commandFamily = classification.commandFamily;
  const existingIndex = next.generatedCodeValidationFailures.findIndex((failure) => (
    failure.kind === classification.kind
    && (failure.path ?? null) === (classification.path ?? null)
    && (failure.language ?? null) === (classification.language ?? null)
  ));
  const failure: GeneratedCodeValidationFailure = existingIndex >= 0
    ? {
      ...next.generatedCodeValidationFailures[existingIndex],
      message: truncateDiagnostic(classification.message),
      count: next.generatedCodeValidationFailures[existingIndex].count + 1,
      updatedAt: now,
    }
    : {
      path: classification.path,
      language: classification.language,
      kind: classification.kind,
      message: truncateDiagnostic(classification.message),
      count: 1,
      updatedAt: now,
    };
  const failures = existingIndex >= 0
    ? next.generatedCodeValidationFailures.map((item, index) => (index === existingIndex ? failure : item))
    : [...next.generatedCodeValidationFailures, failure].slice(-MAX_FAILURES);

  const repeatedPath = Boolean(pathKey && next.recentGeneratedFailurePaths.includes(pathKey));
  const repeatedFamily = Boolean(commandFamily && next.recentCommandFailureFamilies.includes(commandFamily));
  return {
    ...next,
    generatedCodeFailureCount: next.generatedCodeFailureCount + 1,
    sameGeneratedFileFailureCount: repeatedPath ? next.sameGeneratedFileFailureCount + 1 : next.sameGeneratedFileFailureCount,
    sameCommandFamilyFailureCount: repeatedFamily ? next.sameCommandFamilyFailureCount + 1 : next.sameCommandFamilyFailureCount,
    skillSourceMutationBlockedCount: classification.kind === 'skill_source_readonly'
      ? next.skillSourceMutationBlockedCount + 1
      : next.skillSourceMutationBlockedCount,
    recentGeneratedFailurePaths: pathKey ? boundedPush(next.recentGeneratedFailurePaths, pathKey) : next.recentGeneratedFailurePaths,
    recentGeneratedFailureKinds: boundedPush(next.recentGeneratedFailureKinds, classification.kind),
    recentCommandFailureFamilies: commandFamily ? boundedPush(next.recentCommandFailureFamilies, commandFamily) : next.recentCommandFailureFamilies,
    generatedCodeValidationFailures: failures,
  };
}

function calculateRisk(next: RunawayToolObservation): Pick<RunawayToolObservation, 'riskState' | 'riskReasons' | 'pauseReason'> {
  const reasons: string[] = [];
  let riskState: RunawayToolRiskState = 'normal';
  let pauseReason: RunawayToolObservation['pauseReason'] = null;

  if (next.toolCallCount >= 15) {
    riskState = 'needs_convergence';
    reasons.push(`tool_calls>=15 (${next.toolCallCount})`);
  }
  if (next.taskKind !== 'general' && next.generatedCodeFailureCount > 0) {
    riskState = riskState === 'normal' ? 'needs_convergence' : riskState;
    reasons.push(`generated_code_failures>=1 (${next.generatedCodeFailureCount})`);
  }
  if (
    next.writeExecPairCount >= 3
    || next.repeatedExecCommandCount >= 3
    || next.repeatedWriteTargetCount >= 3
    || next.repeatedDebugScriptCount >= 2
    || next.repeatedOutputPatternCount >= 2
    || next.sameGeneratedFileFailureCount >= 1
    || next.sameCommandFamilyFailureCount >= 1
    || next.skillSourceMutationBlockedCount >= 1
  ) {
    riskState = 'debug_loop';
    reasons.push('repeated write/exec debug pattern');
  }
  if (next.repeatedDebugScriptCount >= 2) reasons.push(`repeated debug scripts>=2 (${next.repeatedDebugScriptCount})`);
  if (next.repeatedOutputPatternCount >= 2) reasons.push(`repeated output patterns>=2 (${next.repeatedOutputPatternCount})`);
  if (next.sameGeneratedFileFailureCount >= 1) reasons.push(`same generated file failures>=2 (${next.sameGeneratedFileFailureCount + 1})`);
  if (next.sameCommandFamilyFailureCount >= 1) reasons.push(`same command family failures>=2 (${next.sameCommandFamilyFailureCount + 1})`);
  if (next.skillSourceMutationBlockedCount >= 1) reasons.push(`skill_source_readonly (${next.skillSourceMutationBlockedCount})`);
  if (next.taskKind !== 'general' && next.structuralInspectionCount >= 4) {
    riskState = riskState === 'normal' ? 'needs_convergence' : riskState;
    reasons.push(`structural_inspections>=4 (${next.structuralInspectionCount})`);
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
    pauseReason = 'tool_count_limit';
    reasons.push(`tool_calls>=45 (${next.toolCallCount})`);
  }
  if (next.generatedCodeFailureCount >= 3) {
    riskState = 'needs_pause';
    pauseReason = next.recentGeneratedFailureKinds[next.recentGeneratedFailureKinds.length - 1] as GeneratedCodeFailureKind | undefined ?? 'debug_loop_limit';
    reasons.push(`generated_code_failures>=3 (${next.generatedCodeFailureCount})`);
  }
  if (next.sameGeneratedFileFailureCount >= 2) {
    riskState = 'needs_pause';
    pauseReason = 'repeated_debug_loop';
    reasons.push(`same generated file failures>=3 (${next.sameGeneratedFileFailureCount + 1})`);
  }
  if (next.sameCommandFamilyFailureCount >= 2) {
    riskState = 'needs_pause';
    pauseReason = 'repeated_debug_loop';
    reasons.push(`same command family failures>=3 (${next.sameCommandFamilyFailureCount + 1})`);
  }

  if (next.taskKind !== 'general' && next.toolCallCount >= 10) reasons.push(`document/data task: ${next.taskKind}`);

  return { riskState, riskReasons: reasons, pauseReason };
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
    generatedCodeFailureCount: next.generatedCodeFailureCount,
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
  let lastExecCommand: string | null = null;

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

    if (previousToolName === 'write' && detail.name === 'exec') next.writeExecPairCount += 1;

    if (next.taskKind !== 'general' && isStructuralInspectionTool(detail.name, detail.args)) {
      next.structuralInspectionCount += 1;
    }

    const debugScriptTarget = extractDebugScriptTarget(detail.name, detail.args);
    if (debugScriptTarget) {
      if (next.recentDebugScriptTargets.includes(debugScriptTarget)) next.repeatedDebugScriptCount += 1;
      next.recentDebugScriptTargets = boundedPush(next.recentDebugScriptTargets, debugScriptTarget);
    }

    if (detail.name.toLowerCase() === 'exec') {
      const command = normalizeExecCommand(detail.args);
      if (command) {
        lastExecCommand = command;
        if (next.recentExecCommands.includes(command)) next.repeatedExecCommandCount += 1;
        next.recentExecCommands = boundedPush(next.recentExecCommands, command);
      }
    }

    if (['write', 'edit'].includes(detail.name.toLowerCase())) {
      const target = normalizeWriteTarget(detail.args);
      if (target) {
        if (next.recentWriteTargets.includes(target)) next.repeatedWriteTargetCount += 1;
        next.recentWriteTargets = boundedPush(next.recentWriteTargets, target);
      }
    }

    const toolCallFailure = classifyToolCallFailure(detail);
    if (toolCallFailure) next = recordGeneratedFailure(next, toolCallFailure, now);
  }

  toolUpdates.forEach((update, index) => {
    if (update.status === 'running') return;
    const key = `${runId || next.runId || 'run'}:result:${extractToolResultKey(update, index)}`;
    if (next.seenToolResultKeys.includes(key)) return;
    next.seenToolResultKeys = boundedUniquePush(next.seenToolResultKeys, key);
    next.toolResultCount += 1;
    next.lastToolResultAt = now;
    const fingerprint = normalizeOutputFingerprint(event.message);
    if (fingerprint) {
      if (next.recentOutputFingerprints.includes(fingerprint)) next.repeatedOutputPatternCount += 1;
      next.recentOutputFingerprints = boundedPush(next.recentOutputFingerprints, fingerprint);
    }
    const failure = classifyToolResultFailure(update, event.message, lastExecCommand ?? next.recentExecCommands[next.recentExecCommands.length - 1] ?? null);
    if (failure) next = recordGeneratedFailure(next, failure, now);
  });

  next = { ...next, ...calculateRisk(next) };
  next = applyConvergenceDirective(next, now);
  logRiskTransition(prev, next);
  return next;
}