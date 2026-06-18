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

const OPENAI_TRANSPORT_PARAMS_INJECT_PATTERN = /(const params = \{\s*\n\s*\.\.\.\(model\.params[\s\S]*?\),\s*\n)/;

function injectSessionIdIntoParams(source) {
  if (source.includes('session_id: String(options?.sessionKey')) {
    return { source, patched: false };
  }
  if (source.includes(OPENAI_TRANSPORT_PARAMS_OLD)) {
    return {
      source: source.replace(OPENAI_TRANSPORT_PARAMS_OLD, OPENAI_TRANSPORT_PARAMS_NEW),
      patched: true,
    };
  }
  if (!OPENAI_TRANSPORT_PARAMS_INJECT_PATTERN.test(source)) {
    return { source, patched: false };
  }
  return {
    source: source.replace(
      OPENAI_TRANSPORT_PARAMS_INJECT_PATTERN,
      '$1\t\t...(options?.sessionKey || options?.sessionId ? { session_id: String(options?.sessionKey || options?.sessionId) } : {}),\n',
    ),
    patched: true,
  };
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
  return source.includes('X-LYClaw-Session-Id')
    && source.includes('session_id:')
    && source.includes('options?.sessionKey || options?.sessionId');
}
