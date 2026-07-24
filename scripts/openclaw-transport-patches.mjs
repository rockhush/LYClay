/**
 * Shared OpenClaw OpenAI transport patch snippets for dev (postinstall) and bundle builds.
 */

export const OPENAI_TRANSPORT_SESSION_HEADER_OLD = [
  'const client = createOpenAICompletionsClient(model, context, options?.apiKey || getEnvApiKey(model.provider) || "", options?.headers, (() => { const sid = options?.sessionId; resolveProviderTransportTurnState(model, { sessionId: sid, turnId: randomUUID(), attempt: 1, transport: "stream" }); return model.provider === "ly-auto" && sid ? { "X-LYClaw-Session-Id": sid } : {}; })());',
].join('\n');

export const OPENAI_TRANSPORT_SESSION_HEADER_NEW = [
  'const client = createOpenAICompletionsClient(model, context, options?.apiKey || getEnvApiKey(model.provider) || "", options?.headers, (() => { const sid = options?.sessionKey || options?.sessionId; resolveProviderTransportTurnState(model, { sessionId: sid, turnId: randomUUID(), attempt: 1, transport: "stream" }); return sid ? { "X-LYClaw-Session-Id": String(sid) } : {}; })());',
].join('\n');

export const OPENAI_TRANSPORT_PARAMS_OLD = [
  'const params = {',
  '\t\t...(model.params && typeof model.params === "object" && !Array.isArray(model.params) ? model.params : {}),',
  '\t\tmodel: model.id,',
].join('\n');

export const OPENAI_TRANSPORT_PARAMS_NEW = [
  'const params = {',
  '\t\t...(model.params && typeof model.params === "object" && !Array.isArray(model.params) ? model.params : {}),',
  '\t\t...(options?.sessionKey || options?.sessionId ? { session_id: String(options?.sessionKey || options?.sessionId) } : {}),',
  '\t\tmodel: model.id,',
].join('\n');

// 6.5+ format: params no longer spreads model.params inline
const OPENAI_TRANSPORT_PARAMS_V65 = '\t\tmodel: model.id,\n\t\tmessages:';
const OPENAI_TRANSPORT_PARAMS_V65_PATCHED = '\t\tmodel: model.id,\n\t\t...(options?.sessionKey || options?.sessionId ? { session_id: String(options?.sessionKey || options?.sessionId) } : {}),\n\t\tchat_template_kwargs: { enable_thinking: false },\n\t\tmessages:';

export const OPENAI_TRANSPORT_CLIENT_HEADER_PATCHES = [
  [
    [
      'function createOpenAICompletionsClient(model, context, apiKey, optionHeaders) {',
      '\tconst clientConfig = buildOpenAICompletionsClientConfig(model, context, optionHeaders);',
    ].join('\n'),
    [
      'function createOpenAICompletionsClient(model, context, apiKey, optionHeaders, turnHeaders) {',
      '\tconst clientConfig = buildOpenAICompletionsClientConfig(model, context, optionHeaders, turnHeaders);',
    ].join('\n'),
  ],
  [
    [
      'function buildOpenAICompletionsClientConfig(model, context, optionHeaders) {',
      '\tconst headers = buildOpenAIClientHeaders(model, context, optionHeaders);',
    ].join('\n'),
    [
      'function buildOpenAICompletionsClientConfig(model, context, optionHeaders, turnHeaders) {',
      '\tconst headers = buildOpenAIClientHeaders(model, context, optionHeaders, turnHeaders);',
    ].join('\n'),
  ],
  [
    OPENAI_TRANSPORT_SESSION_HEADER_OLD,
    OPENAI_TRANSPORT_SESSION_HEADER_NEW,
  ],
];


const OPENAI_TRANSPORT_HTML_MESSAGE_SANITIZER_MARKER = 'LYCLAW_OPENAI_TRANSPORT_HTML_MESSAGE_SANITIZER_PATCH';

function openAITransportHtmlMessageSanitizerHelpers() {
  return String.raw`
//#region ${OPENAI_TRANSPORT_HTML_MESSAGE_SANITIZER_MARKER}
function sanitizeOpenAICompletionsHtmlMessageText(value) {
	if (typeof value !== "string" || value.length < 2048) return value;
	const head = value.slice(0, 4096).toLowerCase();
	if (!head.includes("<") || !/(<!doctype\s+html\b|<html\b|<head\b|<body\b|<script\b|<link\b|<noscript\b)/.test(head)) return value;
	let text = value
		.replace(/<script\b[\s\S]*?<\/script>/gi, "")
		.replace(/<style\b[\s\S]*?<\/style>/gi, "")
		.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, "")
		.replace(/<link\b[^>]*>/gi, "")
		.replace(/<!--[\s\S]*?-->/g, "");
	text = text.replace(/https?:\/\/(?:wwwjs\.)?cls\.cn\/[^\s"'<>]+/gi, "");
	if (text.length > 12_000) text = text.slice(0, 12_000) + "\n[LYClaw: HTML-like tool result sanitized before model request]";
	return text;
}
function sanitizeOpenAICompletionsHtmlMessageContent(content) {
	if (typeof content === "string") return sanitizeOpenAICompletionsHtmlMessageText(content);
	if (!Array.isArray(content)) return content;
	return content.map((part) => {
		if (!part || typeof part !== "object" || Array.isArray(part) || typeof part.text !== "string") return part;
		const text = sanitizeOpenAICompletionsHtmlMessageText(part.text);
		return text === part.text ? part : { ...part, text };
	});
}
function sanitizeOpenAICompletionsHtmlMessages(messages) {
	if (!Array.isArray(messages)) return messages;
	return messages.map((message) => {
		if (!message || typeof message !== "object" || Array.isArray(message) || !("content" in message)) return message;
		const content = sanitizeOpenAICompletionsHtmlMessageContent(message.content);
		return content === message.content ? message : { ...message, content };
	});
}
//#endregion
`;
}
const OPENAI_TRANSPORT_PARAMS_INJECT_PATTERN = /(const params = \{\s*\n\s*\.\.\.\(model\.params[\s\S]*?\),\s*\n)/;

function injectSessionIdIntoParams(_source) {
  return { source: _source, patched: false };
}

export function applyOpenClawOpenAITransportPatches(source) {
  let patched = false;

  const paramsPatch = injectSessionIdIntoParams(source);
  source = paramsPatch.source;
  if (paramsPatch.patched) {
    patched = true;
  }

  if (source.includes(OPENAI_TRANSPORT_SESSION_HEADER_OLD)) {
    source = source.replace(OPENAI_TRANSPORT_SESSION_HEADER_OLD, OPENAI_TRANSPORT_SESSION_HEADER_NEW);
    patched = true;
  }

  for (const [search, replace] of OPENAI_TRANSPORT_CLIENT_HEADER_PATCHES.slice(0, 2)) {
    if (source.includes(search)) {
      source = source.replace(search, replace);
      patched = true;
    }
  }

  const clientLineOld = 'const client = createOpenAICompletionsClient(model, context, options?.apiKey || getEnvApiKey(model.provider) || "", options?.headers);';
  if (source.includes(clientLineOld)) {
    source = source.replace(clientLineOld, OPENAI_TRANSPORT_SESSION_HEADER_NEW);
    patched = true;
  }


  if (!source.includes(OPENAI_TRANSPORT_HTML_MESSAGE_SANITIZER_MARKER)) {
    const helperAnchor = 'function stripCompletionMessagesToRoleContent(messages) {\n\treturn messages.map((message) => {\n\t\tif (!message || typeof message !== "object" || Array.isArray(message)) return message;\n\t\tconst record = message;\n\t\tconst stripped = {};\n\t\tif (Object.hasOwn(record, "role")) stripped.role = record.role;\n\t\tif (Object.hasOwn(record, "content")) stripped.content = record.content;\n\t\treturn stripped;\n\t});\n}\n';
    if (source.includes(helperAnchor)) {
      source = source.replace(helperAnchor, `${helperAnchor}${openAITransportHtmlMessageSanitizerHelpers()}`);
      patched = true;
    }
  }

  const htmlMessageLineOld = '\t\tmessages: compat.requiresStringContent ? flattenCompletionMessagesToStringContent(messages) : messages,';
  const htmlMessageLineNew = '\t\tmessages: sanitizeOpenAICompletionsHtmlMessages(compat.requiresStringContent ? flattenCompletionMessagesToStringContent(messages) : messages),';
  if (source.includes(htmlMessageLineOld) && !source.includes(htmlMessageLineNew)) {
    source = source.replace(htmlMessageLineOld, htmlMessageLineNew);
    patched = true;
  }
  const headerMergeOld = '\treturn {\n\t\t...headers,\n\t\t...optionHeaders\n\t};';
  const headerMergeNew = '\treturn {\n\t\t...headers,\n\t\t...optionHeaders,\n\t\t...(turnHeaders ?? {})\n\t};';
  if (source.includes('function buildOpenAIClientHeaders(model, context, optionHeaders, turnHeaders)')
    && source.includes(headerMergeOld)
    && !source.includes('...(turnHeaders ?? {})')) {
    source = source.replace(headerMergeOld, headerMergeNew);
    patched = true;
  }

  return { source, patched };
}

export function hasOpenClawOpenAITransportPatches(source) {
  const hasSessionPatch = (source.includes('X-LYClaw-Session-Id')
    && source.includes('options?.sessionKey || options?.sessionId'))
    || source.includes('session_id: String(options?.sessionKey');
  const hasHtmlSanitizerPatch = source.includes(OPENAI_TRANSPORT_HTML_MESSAGE_SANITIZER_MARKER)
    && source.includes('sanitizeOpenAICompletionsHtmlMessages(compat.requiresStringContent');
  return hasSessionPatch && hasHtmlSanitizerPatch;
}
