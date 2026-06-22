import type {
  ConvergenceDirectiveLevel,
  RunawayToolObservation,
  RunawayToolRiskState,
  TaskWorkflowKind,
} from './types';

const BASE_RULES = [
  'Use a convergent workflow for this document/data task.',
  'Do at most 2-3 structural inspection steps before moving into the main processing plan.',
  'After inspection, write or execute one complete processing flow that includes read, transform, write/save, validation, and error reporting.',
  'Do at most 1-2 validation passes after the main processing step.',
  'If validation cannot resolve an ambiguity, report the blocker and confirmed facts instead of creating more temporary debug scripts.',
  'Avoid repeated write -> exec debug loops. Merge needed checks into one reproducible script or plan.',
];

const KIND_RULES: Record<Exclude<TaskWorkflowKind, 'general'>, string[]> = {
  spreadsheet: [
    'Spreadsheet tasks: identify sheets, key rows/columns, date fields, formulas, cached values, and output cells during inspection.',
    'For Excel formula/cache issues, prefer a single script that reads formulas and values, reconstructs required mappings, writes output, saves, and verifies key cells.',
  ],
  pdf: [
    'PDF tasks: first determine page count, extractability, and relevant pages.',
    'If the file is scanned or text is not extractable, clearly report that OCR/image analysis is required instead of rereading the same pages.',
  ],
  word: [
    'Word tasks: inspect sections, paragraphs, tables, and target locations once, then apply edits in a single pass.',
    'If location matching is ambiguous, report the locations that need user confirmation instead of repeatedly trying near matches.',
  ],
  presentation: [
    'Presentation tasks: inspect slide count, layout, theme, and target content before making changes.',
    'After generating or editing slides, verify export/rendering at most 1-2 times.',
  ],
  'data-analysis': [
    'Data analysis tasks: inspect schema, row count, missing values, and representative samples before analysis.',
    'Prefer one reproducible analysis script that produces statistics, charts/artifacts, and key metric validation.',
  ],
  'batch-files': [
    'Batch file tasks: group files by type, inspect representative samples, then run a bounded batch workflow.',
    'Summarize per-file failures and continue where possible instead of debugging each file with separate ad hoc scripts.',
  ],
};

export function buildInitialConvergenceSystemPrompt(taskKind: TaskWorkflowKind): string | null {
  if (taskKind === 'general') return null;
  return [
    '[LYClaw document/data convergence strategy]',
    ...BASE_RULES.map((rule) => `- ${rule}`),
    ...KIND_RULES[taskKind].map((rule) => `- ${rule}`),
    '[/LYClaw document/data convergence strategy]',
  ].join('\n');
}

function directiveLevelForRisk(riskState: RunawayToolRiskState): ConvergenceDirectiveLevel {
  if (riskState === 'needs_pause' || riskState === 'must_summarize') return 'force';
  if (riskState === 'debug_loop' || riskState === 'tool_heavy') return 'medium';
  if (riskState === 'needs_convergence') return 'light';
  return 'none';
}

function buildLightDirective(observation: RunawayToolObservation): string {
  return [
    'The current task has used many tools. Start converging now.',
    'Reuse existing evidence, reduce repeated inspection, and produce a complete processing plan or script.',
    `Observed tool calls: ${observation.toolCallCount}. Task kind: ${observation.taskKind}.`,
  ].join(' ');
}

function buildMediumDirective(observation: RunawayToolObservation): string {
  return [
    'You have entered a repeated debug/tool pattern.',
    'Stop fragmentary probing. Write one complete processing script or plan that includes reading, processing, writing, validation, and error reporting.',
    'Use at most 1-2 additional validation passes.',
    `Observed write->exec pairs: ${observation.writeExecPairCount}; repeated exec commands: ${observation.repeatedExecCommandCount}; repeated write targets: ${observation.repeatedWriteTargetCount}.`,
  ].join(' ');
}

function buildForceDirective(observation: RunawayToolObservation): string {
  return [
    'This run is at high risk of a runaway tool loop.',
    'Do not create more temporary debug scripts.',
    'Based on existing results, provide a staged conclusion, the current blocker, or one complete executable solution.',
    `Observed tool calls: ${observation.toolCallCount}. Risk: ${observation.riskState}.`,
  ].join(' ');
}

export function buildConvergenceDirective(
  observation: RunawayToolObservation,
): { level: ConvergenceDirectiveLevel; directive: string | null } {
  const level = directiveLevelForRisk(observation.riskState);
  if (level === 'none') return { level, directive: null };
  if (level === 'force') return { level, directive: buildForceDirective(observation) };
  if (level === 'medium') return { level, directive: buildMediumDirective(observation) };
  return { level, directive: buildLightDirective(observation) };
}

export function shouldUpgradeConvergenceDirective(
  current: ConvergenceDirectiveLevel,
  next: ConvergenceDirectiveLevel,
): boolean {
  const order: Record<ConvergenceDirectiveLevel, number> = {
    none: 0,
    light: 1,
    medium: 2,
    force: 3,
  };
  return order[next] > order[current];
}
