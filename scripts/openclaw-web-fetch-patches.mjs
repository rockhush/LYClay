const PATCH_MARKER = 'LYCLAW_WEB_FETCH_HTML_SNIFF_PATCH';

function webFetchPatchHelpers() {
  return `
//#region ${PATCH_MARKER}
function looksLikeHtmlDocumentText(value) {
	if (typeof value !== "string") return false;
	const head = value.slice(0, 4096).toLowerCase();
	if (!head.includes("<")) return false;
	return /<!doctype\s+html\b|<html\b|<head\b|<body\b|<title\b|<script\b|<link\b|<noscript\b/.test(head);
}
//#endregion
`;
}

export function hasOpenClawWebFetchHtmlSniffPatches(source) {
  return source.includes(PATCH_MARKER) && source.includes('contentType.includes("text/html") || looksLikeHtmlDocumentText(body)');
}

export function applyOpenClawWebFetchHtmlSniffPatches(source) {
  if (hasOpenClawWebFetchHtmlSniffPatches(source)) {
    return { source, patched: false };
  }

  let next = source;
  const helperAnchor = 'function throwIfFetchAborted(signal) {\n\tif (!signal?.aborted) return;\n\tthrow signal.reason instanceof Error ? signal.reason : /* @__PURE__ */ new Error("aborted");\n}\n';
  if (!next.includes(helperAnchor)) {
    return { source, patched: false };
  }
  next = next.replace(helperAnchor, `${helperAnchor}${webFetchPatchHelpers()}`);

  const htmlBranch = '} else if (contentType.includes("text/html")) if (params.readabilityEnabled) {';
  if (!next.includes(htmlBranch)) {
    return { source, patched: false };
  }
  next = next.replace(htmlBranch, '} else if (contentType.includes("text/html") || looksLikeHtmlDocumentText(body)) if (params.readabilityEnabled) {');

  return { source: next, patched: next !== source };
}