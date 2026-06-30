/**
 * Mirrors OpenClaw bundled endpoint host classification for LYClaw config sync.
 * Used to pick the correct max-token request field before Gateway reads models.json.
 */

export type OpenClawEndpointClass =
  | 'anthropic-public'
  | 'azure-openai'
  | 'cerebras-native'
  | 'chutes-native'
  | 'custom'
  | 'deepseek-native'
  | 'default'
  | 'github-copilot-native'
  | 'google-generative-ai'
  | 'google-vertex'
  | 'groq-native'
  | 'invalid'
  | 'local'
  | 'mistral-public'
  | 'moonshot-native'
  | 'modelstudio-native'
  | 'nvidia-native'
  | 'openai'
  | 'openai-public'
  | 'opencode-native'
  | 'openrouter'
  | 'xai-native'
  | 'zai-native';

export type OpenClawMaxTokensField = 'max_tokens' | 'max_completion_tokens';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const MOONSHOT_NATIVE_BASE_URLS = new Set([
  'https://api.moonshot.ai',
  'https://api.moonshot.cn',
]);

const MODELSTUDIO_NATIVE_BASE_URLS = new Set([
  'https://dashscope.aliyuncs.com/compatible-mode/v1',
]);

function readHostname(baseUrl: string | undefined): string | undefined {
  if (!baseUrl?.trim()) {
    return undefined;
  }
  const trimmed = baseUrl.trim();
  try {
    return new URL(trimmed).hostname.toLowerCase();
  } catch {
    try {
      return new URL(`https://${trimmed}`).hostname.toLowerCase();
    } catch {
      return undefined;
    }
  }
}

function normalizeComparableBaseUrl(baseUrl: string | undefined): string | undefined {
  if (!baseUrl?.trim()) {
    return undefined;
  }
  try {
    const url = new URL(baseUrl.trim().startsWith('http') ? baseUrl.trim() : `https://${baseUrl.trim()}`);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return undefined;
    }
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/+$/, '').toLowerCase();
  } catch {
    return undefined;
  }
}

function hostMatchesSuffix(host: string, suffix: string): boolean {
  return suffix.startsWith('.') || suffix.startsWith('-')
    ? host.endsWith(suffix)
    : host === suffix || host.endsWith(`.${suffix}`);
}

function isLocalEndpointHost(host: string): boolean {
  return LOCAL_HOSTS.has(host)
    || host.endsWith('.localhost')
    || host.endsWith('.local')
    || host.endsWith('.internal');
}

/** Classify an OpenAI-compatible base URL the same way OpenClaw transport does. */
export function resolveOpenClawEndpointClass(baseUrl: string | undefined): OpenClawEndpointClass {
  if (!baseUrl?.trim()) {
    return 'default';
  }
  const host = readHostname(baseUrl);
  if (!host) {
    return 'invalid';
  }
  const comparableBaseUrl = normalizeComparableBaseUrl(baseUrl);

  switch (host) {
    case 'api.anthropic.com':
      return 'anthropic-public';
    case 'api.cerebras.ai':
      return 'cerebras-native';
    case 'llm.chutes.ai':
      return 'chutes-native';
    case 'api.deepseek.com':
      return 'deepseek-native';
    case 'api.groq.com':
      return 'groq-native';
    case 'api.mistral.ai':
      return 'mistral-public';
    case 'api.openai.com':
      return 'openai-public';
    case 'chatgpt.com':
      return 'openai';
    case 'generativelanguage.googleapis.com':
      return 'google-generative-ai';
    case 'aiplatform.googleapis.com':
      return 'google-vertex';
    case 'api.x.ai':
      return 'xai-native';
    case 'api.z.ai':
      return 'zai-native';
    default:
      break;
  }

  if (hostMatchesSuffix(host, '.githubcopilot.com')) {
    return 'github-copilot-native';
  }
  if (hostMatchesSuffix(host, '.openai.azure.com')) {
    return 'azure-openai';
  }
  if (hostMatchesSuffix(host, 'openrouter.ai')) {
    return 'openrouter';
  }
  if (hostMatchesSuffix(host, 'opencode.ai')) {
    return 'opencode-native';
  }
  if (hostMatchesSuffix(host, '-aiplatform.googleapis.com')) {
    return 'google-vertex';
  }
  if (comparableBaseUrl && MOONSHOT_NATIVE_BASE_URLS.has(comparableBaseUrl)) {
    return 'moonshot-native';
  }
  if (comparableBaseUrl && MODELSTUDIO_NATIVE_BASE_URLS.has(comparableBaseUrl)) {
    return 'modelstudio-native';
  }
  if (isLocalEndpointHost(host)) {
    return 'local';
  }
  return 'custom';
}

/**
 * OpenAI's first-party API prefers max_completion_tokens on newer models.
 * Nearly all other OpenAI-compatible vendors (DeepSeek, vLLM, Ollama, Groq, …) use max_tokens.
 */
export function resolveMaxTokensFieldForEndpoint(endpointClass: OpenClawEndpointClass): OpenClawMaxTokensField {
  if (endpointClass === 'openai-public' || endpointClass === 'openai' || endpointClass === 'azure-openai') {
    return 'max_completion_tokens';
  }
  return 'max_tokens';
}

export function resolveMaxTokensFieldForBaseUrl(baseUrl: string | undefined): OpenClawMaxTokensField {
  return resolveMaxTokensFieldForEndpoint(resolveOpenClawEndpointClass(baseUrl));
}
