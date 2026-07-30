import { describe, expect, it } from 'vitest';
import { applyOpenClawLyclawPatches } from '../../scripts/openclaw-lyclaw-patches.mjs';

describe('applyOpenClawLyclawPatches', () => {
  it('adds chat.send execution target fields', () => {
    const source = `
const chatHandlers = {
  send: async () => {
    await run({
      fastModeOverride: p.fastMode,
      userTurnTranscriptRecorder: userTurnRecorder,
    });
  },
};`;
    const result = applyOpenClawLyclawPatches(source);
    expect(result.patched).toBe(true);
    expect(result.source).toContain('executeAsAgentId');
    expect(result.source).toContain('skillFilter');
  });

  it('is idempotent for chat.send patch', () => {
    const once = applyOpenClawLyclawPatches(`
const chatHandlers = {
  send: async () => {
    await run({
      fastModeOverride: p.fastMode,
      userTurnTranscriptRecorder: userTurnRecorder,
    });
  },
};`);
    const twice = applyOpenClawLyclawPatches(once.source);
    expect(twice.patched).toBe(false);
  });
});
