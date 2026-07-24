import { describe, expect, it } from 'vitest';

import {
  applyOpenClawWebFetchHtmlSniffPatches,
  hasOpenClawWebFetchHtmlSniffPatches,
} from '../../scripts/openclaw-web-fetch-patches.mjs';

const SOURCE = [
  'function throwIfFetchAborted(signal) {',
  '\tif (!signal?.aborted) return;',
  '\tthrow signal.reason instanceof Error ? signal.reason : /* @__PURE__ */ new Error("aborted");',
  '}',
  'async function runWebFetch(params) {',
  '\tconst contentType = res.headers.get("content-type") ?? "application/octet-stream";',
  '\tconst body = bodyResult.text;',
  '\tif (contentType.includes("text/markdown")) {',
  '\t\textractor = "cf-markdown";',
  '\t} else if (contentType.includes("text/html")) if (params.readabilityEnabled) {',
  '\t\tconst readable = await extractReadableContent({ html: body });',
  '\t}',
  '}',
].join('\n');

describe('openclaw-web-fetch-patches', () => {
  it('patches web_fetch to treat HTML-like octet-stream bodies as HTML', () => {
    const result = applyOpenClawWebFetchHtmlSniffPatches(SOURCE);

    expect(result.patched).toBe(true);
    expect(result.source).toContain('LYCLAW_WEB_FETCH_HTML_SNIFF_PATCH');
    expect(result.source).toContain('contentType.includes("text/html") || looksLikeHtmlDocumentText(body)');
    expect(hasOpenClawWebFetchHtmlSniffPatches(result.source)).toBe(true);
  });

  it('is idempotent', () => {
    const once = applyOpenClawWebFetchHtmlSniffPatches(SOURCE).source;
    const twice = applyOpenClawWebFetchHtmlSniffPatches(once);

    expect(twice.patched).toBe(false);
    expect(twice.source).toBe(once);
  });
});