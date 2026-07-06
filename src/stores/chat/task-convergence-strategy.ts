import type {
  ConvergenceDirectiveLevel,
  RunawayToolObservation,
  RunawayToolRiskState,
  TaskWorkflowKind,
} from './types';

const BASE_RULES = [
  'Use a convergent workflow for this document/data task.',
  'Do at most 2-3 structural inspection steps before moving into the main processing plan.',
  'After inspection, choose one bounded implementation path that includes read, transform, write/save, validation, and error reporting.',
  'Validate generated .py, .js, .ts, .mjs, .cjs, .json, and shell-script files before building on them; check for null bytes first.',
  'For Python, validate syntax with py_compile or an equivalent parser check before execution; do not use execution as syntax validation.',
  'For JSON, parse the file as JSON before using it.',
  'Do at most 1-2 validation passes after the main processing step.',
  'Windows shell guidance: do not use heredoc syntax, do not rely on && in PowerShell, do not run Python files with Node, and keep generated script content UTF-8 text without null bytes.',
  'Installed skill source is read-only for ordinary tasks. Read or import it if needed, but create a workspace runner/wrapper or report a skill defect instead of patching installed skills.',
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

function formatFailures(observation: RunawayToolObservation): string {
  if (observation.generatedCodeValidationFailures.length === 0) return 'No structured generated-code failures recorded yet.';
  return observation.generatedCodeValidationFailures.slice(-4).map((failure) => {
    const path = failure.path ? ` path=${failure.path}` : '';
    const language = failure.language ? ` language=${failure.language}` : '';
    return `${failure.kind}${path}${language} count=${failure.count}`;
  }).join('; ');
}

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
    'The current task has used many tools or hit generated-code validation trouble. Start converging now.',
    'Reuse existing evidence, reduce repeated inspection, and produce one bounded processing plan or script.',
    'Validate generated code before execution and avoid repeating the same shell/file path.',
    `Observed tool calls: ${observation.toolCallCount}. Structural inspections: ${observation.structuralInspectionCount}. Generated-code failures: ${observation.generatedCodeFailureCount}. Task kind: ${observation.taskKind}.`,
  ].join(' ');
}

function buildMediumDirective(observation: RunawayToolObservation): string {
  return [
    'You have entered a repeated debug/tool pattern.',
    'Stop fragmentary probing. Write one complete processing script or plan that includes reading, processing, writing, validation, and error reporting.',
    'Use at most 1 additional validation pass, and do not repeat the same command or rewrite the same file with the same strategy.',
    'Do not patch installed skill source; create a workspace wrapper or report the skill defect instead.',
    `Observed write->exec pairs: ${observation.writeExecPairCount}; repeated exec commands: ${observation.repeatedExecCommandCount}; repeated write targets: ${observation.repeatedWriteTargetCount}; repeated debug scripts: ${observation.repeatedDebugScriptCount}; generated-code failures: ${observation.generatedCodeFailureCount}; skill-source blocks: ${observation.skillSourceMutationBlockedCount}. Failures: ${formatFailures(observation)}.`,
  ].join(' ');
}

function buildForceDirective(observation: RunawayToolObservation): string {
  return [
    'This run has reached the pause threshold for a generated-script or runaway tool loop.',
    'Do not repeat the same command. Do not rewrite the same generated file with the same strategy. Do not patch installed skill source during this task.',
    'Stop automatic self-repair for this path. Summarize what failed, what evidence is confirmed, and ask the user whether to simplify the task, repair/update the skill separately, or continue with a smaller bounded step.',
    `Observed tool calls: ${observation.toolCallCount}. Structural inspections: ${observation.structuralInspectionCount}. Generated-code failures: ${observation.generatedCodeFailureCount}. Same-file failures: ${observation.sameGeneratedFileFailureCount}. Same-command-family failures: ${observation.sameCommandFamilyFailureCount}. Pause reason: ${observation.pauseReason ?? observation.riskState}. Failures: ${formatFailures(observation)}.`,
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