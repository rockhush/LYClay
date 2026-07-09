export const LY_AUTO_PROVIDER_ID = 'ly-auto' as const;

export const PROVIDER_TYPES = [
  LY_AUTO_PROVIDER_ID,
  'anthropic',
  'openai',
  'google',
  'openrouter',
  'ark',
  'deepseek',
  'moonshot',
  'moonshot-global',
  'siliconflow',
  'minimax-portal',
  'minimax-portal-cn',
  'modelstudio',
  'ollama',
  'custom',
] as const;

export const BUILTIN_PROVIDER_TYPES = [
  LY_AUTO_PROVIDER_ID,
  'anthropic',
  'openai',
  'google',
  'openrouter',
  'ark',
  'deepseek',
  'moonshot',
  'moonshot-global',
  'siliconflow',
  'minimax-portal',
  'minimax-portal-cn',
  'modelstudio',
  'ollama',
] as const;

export type ProviderType = (typeof PROVIDER_TYPES)[number];
export type BuiltinProviderType = (typeof BUILTIN_PROVIDER_TYPES)[number];

export const OLLAMA_PLACEHOLDER_API_KEY = 'ollama-local';

export type ProviderProtocol =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages';

export type ProviderAuthMode =
  | 'api_key'
  | 'oauth_device'
  | 'oauth_browser'
  | 'local';

export type ProviderVendorCategory =
  | 'official'
  | 'compatible'
  | 'local'
  | 'custom';

export interface ProviderConfig {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl?: string;
  apiProtocol?: ProviderProtocol;
  headers?: Record<string, string>;
  model?: string;
  fallbackModels?: string[];
  fallbackProviderIds?: string[];
  runtimeModels?: ProviderModelEntry[];
  metadata?: ProviderAccount['metadata'];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderWithKeyInfo extends ProviderConfig {
  hasKey: boolean;
  keyMasked: string | null;
}

export interface ProviderTypeInfo {
  id: ProviderType;
  name: string;
  icon: string;
  placeholder: string;
  model?: string;
  requiresApiKey: boolean;
  defaultBaseUrl?: string;
  showBaseUrl?: boolean;
  showModelId?: boolean;
  showModelIdInDevModeOnly?: boolean;
  modelIdPlaceholder?: string;
  defaultModelId?: string;
  isOAuth?: boolean;
  supportsApiKey?: boolean;
  apiKeyUrl?: string;
  codePlanPresetBaseUrl?: string;
  codePlanPresetModelId?: string;
  codePlanDocsUrl?: string;
}

export interface ProviderModelEntry extends Record<string, unknown> {
  id: string;
  name: string;
}

export interface ProviderBackendConfig {
  baseUrl: string;
  api: ProviderProtocol;
  apiKeyEnv: string;
  models?: ProviderModelEntry[];
  headers?: Record<string, string>;
}

export interface ProviderDefinition extends ProviderTypeInfo {
  category: ProviderVendorCategory;
  envVar?: string;
  providerConfig?: ProviderBackendConfig;
  supportedAuthModes: ProviderAuthMode[];
  defaultAuthMode: ProviderAuthMode;
  supportsMultipleAccounts: boolean;
}

export interface ProviderAccount {
  id: string;
  vendorId: ProviderType;
  label: string;
  authMode: ProviderAuthMode;
  baseUrl?: string;
  apiProtocol?: ProviderProtocol;
  headers?: Record<string, string>;
  model?: string;
  fallbackModels?: string[];
  fallbackAccountIds?: string[];
  runtimeModels?: ProviderModelEntry[];
  enabled: boolean;
  isDefault: boolean;
  metadata?: {
    region?: string;
    email?: string;
    resourceUrl?: string;
    customModels?: string[];
    managedBy?: 'lyclaw' | 'sub2api';
    scope?: 'global' | 'digitalEmployee';
    subjectHash?: string;
    hiddenInProviderSettings?: boolean;
    lastSuccessAt?: string;
    readonly?: boolean;
  };
  createdAt: string;
  updatedAt: string;
}

export type ProviderSecret =
  | {
    type: 'api_key';
    accountId: string;
    apiKey: string;
  }
  | {
    type: 'oauth';
    accountId: string;
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes?: string[];
    email?: string;
    subject?: string;
  }
  | {
    type: 'local';
    accountId: string;
    apiKey?: string;
  };

export interface ModelSummary {
  id: string;
  name: string;
  vendorId: string;
  accountId?: string;
  supportsVision?: boolean;
  supportsReasoning?: boolean;
  contextWindow?: number;
  pricing?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  source: 'builtin' | 'remote' | 'gateway' | 'custom';
}

