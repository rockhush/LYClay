import { describe, expect, it } from 'vitest';
import {
  applyOpenClawOpenAITransportPatches,
  hasOpenClawOpenAITransportPatches,
  OPENAI_TRANSPORT_PARAMS_OLD,
  OPENAI_TRANSPORT_SESSION_HEADER_OLD,
} from '../../scripts/openclaw-transport-patches.mjs';

describe('openclaw-transport-patches', () => {
  it('injects session_id body field and conversation-level session header', () => {
    const source = [
      OPENAI_TRANSPORT_PARAMS_OLD,
      OPENAI_TRANSPORT_SESSION_HEADER_OLD,
      'function buildOpenAIClientHeaders(model, context, optionHeaders, turnHeaders) {',
      '\treturn {',
      '\t\t...headers,',
      '\t\t...optionHeaders',
      '\t};',
      '}',
    ].join('\n');

    const { source: patched, patched: changed } = applyOpenClawOpenAITransportPatches(source);
    expect(changed).toBe(true);
    expect(hasOpenClawOpenAITransportPatches(patched)).toBe(true);
    expect(patched).toContain('session_id: String(options?.sessionKey || options?.sessionId)');
    expect(patched).toContain('options?.sessionKey || options?.sessionId');
    expect(patched).not.toContain('model.provider === "ly-auto"');
  });
});
