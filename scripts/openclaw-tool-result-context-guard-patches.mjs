/**
 * Keep OpenClaw's coarse tool-result context guard from failing runs when
 * mid-turn precheck is disabled. Large sessions still rely on normal
 * compaction/provider budget handling.
 */

export const TOOL_RESULT_CONTEXT_GUARD_PATCH_MARKER = 'LYCLAW_TOOL_RESULT_CONTEXT_GUARD_PATCH';

const UNCONDITIONAL_PREEMPTIVE_THROW = `\t\tif (exceedsPreemptiveOverflowThreshold({
\t\t\tmessages: contextMessages,
\t\t\tmaxContextChars
\t\t})) throw new Error(PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE);`;

const MIDTURN_ONLY_PREEMPTIVE_THROW = `\t\t// ${TOOL_RESULT_CONTEXT_GUARD_PATCH_MARKER}: the coarse char-based guard is too conservative for large-context models.
\t\t// Only hard-fail here when the explicit mid-turn precheck mode is enabled.
\t\tif (params.midTurnPrecheck?.enabled === true && exceedsPreemptiveOverflowThreshold({
\t\t\tmessages: contextMessages,
\t\t\tmaxContextChars
\t\t})) throw new Error(PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE);
\t\tif (params.midTurnPrecheck?.enabled !== true && exceedsPreemptiveOverflowThreshold({
\t\t\tmessages: contextMessages,
\t\t\tmaxContextChars
\t\t})) log$2.warn(\`[tool-result-context-guard] skipped preemptive overflow throw because midTurnPrecheck is disabled; messages=\${contextMessages.length} maxContextChars=\${maxContextChars}\`);`;

export function hasOpenClawToolResultContextGuardPatches(source) {
  return source.includes(TOOL_RESULT_CONTEXT_GUARD_PATCH_MARKER);
}

export function applyOpenClawToolResultContextGuardPatches(source) {
  if (!source.includes('function installToolResultContextGuard(params)')) {
    return { source, patched: false };
  }
  if (hasOpenClawToolResultContextGuardPatches(source)) {
    return { source, patched: false };
  }
  if (!source.includes(UNCONDITIONAL_PREEMPTIVE_THROW)) {
    return { source, patched: false };
  }

  return {
    source: source.replace(UNCONDITIONAL_PREEMPTIVE_THROW, MIDTURN_ONLY_PREEMPTIVE_THROW),
    patched: true,
  };
}
