import type { TFunction } from 'i18next';
import type { TaskStep } from './task-visualization';

export type ExecutionStepPresentation = {
  label: string;
  detail?: string;
};

export function isNonActionableRunEnabledStep(step: TaskStep): boolean {
  if (step.status !== 'completed') return false;

  const label = step.label.replace(/\s+/g, ' ').trim().toLowerCase();
  const detail = step.detail?.replace(/\s+/g, ' ').trim().toLowerCase() ?? '';
  return /^run\s*:?\s*enabled$/.test(label)
    || (label === 'run' && /^enabled[.!]?$/.test(detail));
}

const NON_BLOCKING_TOOL_FAILURE_NAME =
  /^(?:write|nodes?|apply[\s_-]*patch|message|cron|exec|canvas)(?:\b|[_-])/i;
const NON_BLOCKING_TOOL_FAILURE_TEXT =
  /^(?:write|nodes?|apply[\s_-]*patch|message|cron|exec|canvas)\s+failed[.!]?$/i;

/**
 * Tool failures that are useful while a run is unresolved, but become
 * non-actionable noise after the run produces an explicit successful result.
 */
export function isNonBlockingToolFailureStep(step: TaskStep): boolean {
  const label = step.label.replace(/\s+/g, ' ').trim();
  const detail = step.detail?.replace(/\s+/g, ' ').trim() ?? '';

  if (step.status === 'error' && NON_BLOCKING_TOOL_FAILURE_NAME.test(label)) {
    return true;
  }

  return step.kind === 'message'
    && (NON_BLOCKING_TOOL_FAILURE_TEXT.test(label) || NON_BLOCKING_TOOL_FAILURE_TEXT.test(detail));
}

export function resolveExecutionStepPresentation(
  step: TaskStep,
  t: TFunction<'chat'>,
): ExecutionStepPresentation {
  if (step.status !== 'error') {
    return { label: step.label, detail: step.detail };
  }

  const label = step.label.replace(/\s+/g, ' ').trim().toLowerCase();
  const key = (() => {
    if (/^cron\b/.test(label)) return 'cron';
    if (/^update goal\b/.test(label)) return 'updateGoal';
    if (/^nodes?\b/.test(label)) return 'nodes';
    if (/^message\b/.test(label)) return 'message';
    if (/^skill[_\s-]?workshop\b/.test(label)) return 'skillWorkshop';
    if (/^canvas\b/.test(label)) return 'canvas';
    if (/^browser\b/.test(label)) return 'browser';
    if (/^(?:cmd|exec|shell|powershell|python)\b/.test(label)) return 'command';
    if (/^response\b/.test(label)) return 'response';
    return null;
  })();

  if (!key) return { label: step.label, detail: step.detail };

  return {
    label: t(`executionGraph.toolErrors.${key}Title`),
    detail: t(`executionGraph.toolErrors.${key}Detail`),
  };
}
