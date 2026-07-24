import { describe, expect, it } from 'vitest';
import {
  applyOpenClawOpenAITransportPatches,
  hasOpenClawOpenAITransportPatches,
  OPENAI_TRANSPORT_SESSION_HEADER_OLD,
} from '../../scripts/openclaw-transport-patches.mjs';

const SOURCE = [
  'function stripCompletionMessagesToRoleContent(messages) {',
  '\treturn messages.map((message) => {',
  '\t\tif (!message || typeof message !== "object" || Array.isArray(message)) return message;',
  '\t\tconst record = message;',
  '\t\tconst stripped = {};',
  '\t\tif (Object.hasOwn(record, "role")) stripped.role = record.role;',
  '\t\tif (Object.hasOwn(record, "content")) stripped.content = record.content;',
  '\t\treturn stripped;',
  '\t});',
  '}',
  'function buildOpenAICompletionsParams(model, context, options) {',
  '\tconst params = {',
  '\t\tmodel: model.id,',
  '\t\tmessages: compat.requiresStringContent ? flattenCompletionMessagesToStringContent(messages) : messages,',
  '\t\tstream: true',
  '\t};',
  '}',
  OPENAI_TRANSPORT_SESSION_HEADER_OLD,
  'function buildOpenAIClientHeaders(model, context, optionHeaders, turnHeaders) {',
  '\treturn {',
  '\t\t...headers,',
  '\t\t...optionHeaders',
  '\t};',
  '}',
].join('\n');

describe('openclaw-transport-patches', () => {
  it('injects session headers and sanitizes HTML-like completion history', () => {
    const { source: patched, patched: changed } = applyOpenClawOpenAITransportPatches(SOURCE);

    expect(changed).toBe(true);
    expect(hasOpenClawOpenAITransportPatches(patched)).toBe(true);
    expect(patched).toContain('options?.sessionKey || options?.sessionId');
    expect(patched).toContain('X-LYClaw-Session-Id');
    expect(patched).toContain('LYCLAW_OPENAI_TRANSPORT_HTML_MESSAGE_SANITIZER_PATCH');
    expect(patched).toContain('sanitizeOpenAICompletionsHtmlMessages(compat.requiresStringContent');
    expect(patched).not.toContain('model.provider === "ly-auto"');
  });

  it('is idempotent', () => {
    const once = applyOpenClawOpenAITransportPatches(SOURCE).source;
    const twice = applyOpenClawOpenAITransportPatches(once);

    expect(twice.patched).toBe(false);
    expect(twice.source).toBe(once);
  });
});