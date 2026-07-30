import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  applyOpenClawToolResultContextGuardPatches,
  hasOpenClawToolResultContextGuardPatches,
} from '../../scripts/openclaw-tool-result-context-guard-patches.mjs';

const SOURCE = [
  'function installToolResultContextGuard(params) {',
  '\tconst contextWindowTokens = Math.max(1, Math.floor(params.contextWindowTokens));',
  '\tconst maxContextChars = Math.max(1024, Math.floor(contextWindowTokens * 4 * PREEMPTIVE_OVERFLOW_RATIO));',
  '\tconst maxSingleToolResultChars = Math.max(1024, Math.floor(contextWindowTokens * 2 * SINGLE_TOOL_RESULT_CONTEXT_SHARE));',
  '\tconst mutableAgent = params.agent;',
  '\tmutableAgent.transformContext = (async (messages, signal) => {',
  '\t\tconst contextMessages = messages;',
  '\t\tif (params.midTurnPrecheck?.enabled) {',
  '\t\t\tconst request = null;',
  '\t\t\tif (request) {',
  '\t\t\t\tparams.midTurnPrecheck.onMidTurnPrecheck?.(request);',
  '\t\t\t\tthrow new MidTurnPrecheckSignal(request);',
  '\t\t\t}',
  '\t\t}',
  '\t\tif (exceedsPreemptiveOverflowThreshold({',
  '\t\t\tmessages: contextMessages,',
  '\t\t\tmaxContextChars',
  '\t\t})) throw new Error(PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE);',
  '\t\treturn contextMessages;',
  '\t});',
  '}',
].join('\n');

describe('openclaw-tool-result-context-guard-patches', () => {
  it('keeps preemptive overflow throws behind midTurnPrecheck', () => {
    expect(hasOpenClawToolResultContextGuardPatches(SOURCE)).toBe(false);

    const result = applyOpenClawToolResultContextGuardPatches(SOURCE);

    expect(result.patched).toBe(true);
    expect(hasOpenClawToolResultContextGuardPatches(result.source)).toBe(true);
    expect(result.source).toContain('LYCLAW_TOOL_RESULT_CONTEXT_GUARD_PATCH');
    expect(result.source).toContain('if (params.midTurnPrecheck?.enabled === true && exceedsPreemptiveOverflowThreshold({');
    expect(result.source).toContain('log$2.warn(`[tool-result-context-guard] skipped preemptive overflow throw because midTurnPrecheck is disabled');
    expect(result.source).not.toContain([
      '\t\tif (exceedsPreemptiveOverflowThreshold({',
      '\t\t\tmessages: contextMessages,',
      '\t\t\tmaxContextChars',
      '\t\t})) throw new Error(PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE);',
    ].join('\n'));
  });

  it('is idempotent', () => {
    const once = applyOpenClawToolResultContextGuardPatches(SOURCE).source;
    const twice = applyOpenClawToolResultContextGuardPatches(once);

    expect(twice.patched).toBe(false);
    expect(twice.source).toBe(once);
  });

  it('is wired into development and bundle patch scripts', () => {
    const devPatchSource = readFileSync(join(process.cwd(), 'scripts', 'patch-openclaw-dev.mjs'), 'utf8');
    const bundlePatchSource = readFileSync(join(process.cwd(), 'scripts', 'bundle-openclaw.mjs'), 'utf8');

    expect(devPatchSource).toContain("from './openclaw-tool-result-context-guard-patches.mjs'");
    expect(devPatchSource).toContain('tool-result-context-guard=applied');
    expect(bundlePatchSource).toContain("from './openclaw-tool-result-context-guard-patches.mjs'");
    expect(bundlePatchSource).toContain('tool-result context guard');
  });
});
