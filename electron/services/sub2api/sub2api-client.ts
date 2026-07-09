import { proxyAwareFetch } from '../../utils/proxy-fetch';
import { logger } from '../../utils/logger';

export type Sub2ApiClientConfig = {
  baseUrl: string;
  adminApiKey: string;
  timeoutMs?: number;
  allowedHosts?: string[];
};

export type Sub2ApiErrorCategory =
  | 'bad-request'
  | 'auth'
  | 'permission'
  | 'not-found'
  | 'ambiguous-user'
  | 'payload-too-large'
  | 'too-many-keys'
  | 'upstream'
  | 'unavailable'
  | 'timeout'
  | 'invalid-response';

export class Sub2ApiClientError extends Error {
  code: string;
  category: Sub2ApiErrorCategory;
  httpStatus?: number;

  constructor(message: string, options: { code: string; category: Sub2ApiErrorCategory; httpStatus?: number }) {
    super(message);
    this.name = 'Sub2ApiClientError';
    this.code = options.code;
    this.category = options.category;
    this.httpStatus = options.httpStatus;
  }
}

export type CompletedSub2ApiModel = {
  modelId: string;
  displayName?: string;
  input: Array<'text' | 'image'>;
  contextWindow: number;
  contextTokens: number;
  maxTokens: number;
  timeoutSeconds: number;
  reasoning: boolean;
  compat: {
    supportsUsageInStreaming: boolean;
    supportsPromptCacheKey: boolean;
    thinkingFormat: string;
    maxTokensField: string;
  } & Record<string, unknown>;
};

export type NormalizedSub2ApiCredential = {
  credentialId: string;
  apiKey: string;
  baseUrl: string;
  models: CompletedSub2ApiModel[];
};

export type Sub2ApiUserProviderResult = {
  userNo: string;
  userId: number;
  provider: {
    providerId: 'sub2api';
    protocol: 'openai-compatible';
    baseUrl: string;
    timeoutSeconds?: number;
  };
  credentials: NormalizedSub2ApiCredential[];
};

type RawSub2ApiResponse = {
  code?: unknown;
  message?: unknown;
  data?: unknown;
};

type RawModel = string | Record<string, unknown>;

type RawCredential = {
  apiKeyId?: unknown;
  apiKeyName?: unknown;
  apiKey?: unknown;
  groupId?: unknown;
  groupName?: unknown;
  models?: unknown;
  modelQueryError?: unknown;
};

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_CONTEXT_WINDOW = 200000;
const DEFAULT_MAX_TOKENS = 16384;
const DEFAULT_MODEL_TIMEOUT_SECONDS = 900;
const SUPPORTED_INPUT = new Set(['text', 'image']);

const ERROR_CATEGORY_BY_CODE: Record<string, Sub2ApiErrorCategory> = {
  '40001': 'bad-request',
  '40101': 'auth',
  '40301': 'permission',
  '40401': 'not-found',
  '40901': 'ambiguous-user',
  '41301': 'payload-too-large',
  '42201': 'too-many-keys',
  '50201': 'upstream',
  '50301': 'unavailable',
  '50401': 'timeout',
};

function assertRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Sub2ApiClientError(`${field} is invalid`, { code: 'invalid-response', category: 'invalid-response' });
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Sub2ApiClientError(`${field} is required`, { code: 'invalid-response', category: 'invalid-response' });
  }
  return value.trim();
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Sub2ApiClientError(`${field} is required`, { code: 'invalid-response', category: 'invalid-response' });
  }
  return value;
}

function optionalPositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Sub2API base URL must use http or https');
  }
  return url.toString().replace(/\/+$/, '');
}

function assertAllowedHost(urlValue: string, allowedHosts: string[], message: string): void {
  const url = new URL(urlValue);
  const allowed = new Set(allowedHosts.map((host) => host.trim()).filter(Boolean));
  if (!allowed.has(url.host) && !allowed.has(url.hostname)) {
    throw new Error(message);
  }
}

function normalizeAllowedHosts(baseUrl: string, allowedHosts?: string[]): string[] {
  const baseHost = new URL(baseUrl).host;
  return allowedHosts?.length ? allowedHosts : [baseHost];
}

function errorFromResponse(body: RawSub2ApiResponse, httpStatus: number): Sub2ApiClientError {
  const code = typeof body.code === 'number' || typeof body.code === 'string'
    ? String(body.code)
    : String(httpStatus);
  const category = ERROR_CATEGORY_BY_CODE[code] ?? 'invalid-response';
  const message = typeof body.message === 'string' && body.message.trim()
    ? body.message.trim()
    : `Sub2API request failed with ${code}`;
  return new Sub2ApiClientError(message, { code, category, httpStatus });
}

function normalizeInput(value: unknown): Array<'text' | 'image'> {
  if (!Array.isArray(value)) return ['text', 'image'];
  const filtered = value.filter((item): item is 'text' | 'image' => typeof item === 'string' && SUPPORTED_INPUT.has(item));
  return filtered.length > 0 ? filtered : ['text', 'image'];
}

function normalizeCompat(value: unknown): CompletedSub2ApiModel['compat'] {
  const compat = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    ...compat,
    supportsUsageInStreaming: typeof compat.supportsUsageInStreaming === 'boolean'
      ? compat.supportsUsageInStreaming
      : true,
    supportsPromptCacheKey: typeof compat.supportsPromptCacheKey === 'boolean'
      ? compat.supportsPromptCacheKey
      : true,
    thinkingFormat: typeof compat.thinkingFormat === 'string' && compat.thinkingFormat.trim()
      ? compat.thinkingFormat.trim()
      : 'qwen-chat-template',
    maxTokensField: typeof compat.maxTokensField === 'string' && compat.maxTokensField.trim()
      ? compat.maxTokensField.trim()
      : 'max_tokens',
  };
}

function normalizeModel(rawModel: RawModel, providerTimeoutSeconds?: number): CompletedSub2ApiModel {
  const model = typeof rawModel === 'string' ? { modelId: rawModel } : rawModel;
  const modelId = requireString(model.modelId, 'credentials[].models[].modelId');
  const contextWindow = optionalPositiveNumber(model.contextWindow) ?? DEFAULT_CONTEXT_WINDOW;
  const contextTokens = optionalPositiveNumber(model.contextTokens) ?? contextWindow;
  return {
    modelId,
    ...(typeof model.displayName === 'string' && model.displayName.trim() ? { displayName: model.displayName.trim() } : {}),
    input: normalizeInput(model.input),
    contextWindow,
    contextTokens,
    maxTokens: optionalPositiveNumber(model.maxTokens) ?? DEFAULT_MAX_TOKENS,
    timeoutSeconds: optionalPositiveNumber(model.timeoutSeconds)
      ?? providerTimeoutSeconds
      ?? DEFAULT_MODEL_TIMEOUT_SECONDS,
    reasoning: typeof model.reasoning === 'boolean' ? model.reasoning : true,
    compat: normalizeCompat(model.compat),
  };
}

function normalizeCredentials(
  rawCredentials: unknown,
  providerBaseUrl: string,
  providerTimeoutSeconds: number | undefined,
): NormalizedSub2ApiCredential[] {
  if (!Array.isArray(rawCredentials)) {
    throw new Sub2ApiClientError('data.credentials is required', { code: 'invalid-response', category: 'invalid-response' });
  }

  const credentials: NormalizedSub2ApiCredential[] = [];
  for (const raw of rawCredentials) {
    const credential = assertRecord(raw, 'credentials[]') as RawCredential;
    if (typeof credential.modelQueryError === 'string' && credential.modelQueryError.trim()) {
      continue;
    }
    const apiKeyId = requireNumber(credential.apiKeyId, 'credentials[].apiKeyId');
    const apiKey = requireString(credential.apiKey, 'credentials[].apiKey');
    if (!Array.isArray(credential.models)) {
      throw new Sub2ApiClientError('credentials[].models is required', { code: 'invalid-response', category: 'invalid-response' });
    }
    const models = credential.models.map((model) => {
      if (typeof model !== 'string' && (typeof model !== 'object' || model === null || Array.isArray(model))) {
        throw new Sub2ApiClientError('credentials[].models contains unsupported model', { code: 'invalid-response', category: 'invalid-response' });
      }
      return normalizeModel(model as RawModel, providerTimeoutSeconds);
    });
    credentials.push({
      credentialId: `apiKey-${apiKeyId}`,
      apiKey,
      baseUrl: providerBaseUrl,
      models,
    });
  }
  return credentials;
}

function normalizeSuccessResponse(body: RawSub2ApiResponse, allowedHosts: string[]): Sub2ApiUserProviderResult {
  const data = assertRecord(body.data, 'data');
  const provider = assertRecord(data.provider, 'data.provider');
  const providerId = requireString(provider.providerId, 'data.provider.providerId');
  const protocol = requireString(provider.protocol, 'data.provider.protocol');
  if (providerId !== 'sub2api' || protocol !== 'openai-compatible') {
    throw new Sub2ApiClientError('data.provider is unsupported', { code: 'invalid-response', category: 'invalid-response' });
  }
  const providerBaseUrl = normalizeBaseUrl(requireString(provider.baseUrl, 'data.provider.baseUrl'));
  assertAllowedHost(providerBaseUrl, allowedHosts, 'Sub2API provider base URL host is not allowed');
  const providerTimeoutSeconds = optionalPositiveNumber(provider.timeoutSeconds);
  return {
    userNo: requireString(data.userNo, 'data.userNo'),
    userId: requireNumber(data.userId, 'data.userId'),
    provider: {
      providerId: 'sub2api',
      protocol: 'openai-compatible',
      baseUrl: providerBaseUrl,
      ...(providerTimeoutSeconds ? { timeoutSeconds: providerTimeoutSeconds } : {}),
    },
    credentials: normalizeCredentials(data.credentials, providerBaseUrl, providerTimeoutSeconds),
  };
}

export function createSub2ApiClient(config: Sub2ApiClientConfig) {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const adminApiKey = requireString(config.adminApiKey, 'adminApiKey');
  const allowedHosts = normalizeAllowedHosts(baseUrl, config.allowedHosts);
  assertAllowedHost(baseUrl, allowedHosts, 'Sub2API base URL host is not allowed');
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async fetchUserProviderByUsername(userNo: string): Promise<Sub2ApiUserProviderResult> {
      const normalizedUserNo = requireString(userNo, 'userNo');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const endpoint = `${baseUrl}/api/integration/user-provider/by-username`;
        logger.info(`[Sub2API] Requesting user provider endpoint=${endpoint}`);
        const response = await proxyAwareFetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'x-api-key': adminApiKey,
          },
          body: JSON.stringify({ userNo: normalizedUserNo }),
          signal: controller.signal,
        });
        const body = await response.json() as RawSub2ApiResponse;
        if (!response.ok || body.code !== 0) {
          throw errorFromResponse(body, response.status);
        }
        return normalizeSuccessResponse(body, allowedHosts);
      } catch (error) {
        if (error instanceof Sub2ApiClientError) throw error;
        if (error instanceof Error && error.name === 'AbortError') {
          throw new Sub2ApiClientError('Sub2API request timed out', { code: 'timeout', category: 'timeout' });
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
