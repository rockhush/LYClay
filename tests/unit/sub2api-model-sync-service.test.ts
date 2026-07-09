import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DigitalEmployeePackageManifest } from '../../shared/types/digital-employee';

const mocks = vi.hoisted(() => ({
  getSetting: vi.fn(),
  createSub2ApiClient: vi.fn(),
  reconcileGlobalSub2ApiProviders: vi.fn(),
  writeDigitalEmployeeModelScope: vi.fn(),
  readDigitalEmployeeModelScope: vi.fn(),
  deleteDigitalEmployeeModelScope: vi.fn(),
  setProviderSecret: vi.fn(),
  deleteProviderSecret: vi.fn(),
  syncSavedProviderToRuntime: vi.fn(),
  syncDeletedProviderToRuntime: vi.fn(),
  syncDefaultProviderToRuntime: vi.fn(),
  recordStarted: vi.fn(),
  recordSuccess: vi.fn(),
  recordFailure: vi.fn(),
  listStatus: vi.fn(),
}));

vi.mock('@electron/utils/store', () => ({ getSetting: mocks.getSetting }));
vi.mock('@electron/services/sub2api/sub2api-client', () => ({
  createSub2ApiClient: mocks.createSub2ApiClient,
  Sub2ApiClientError: class Sub2ApiClientError extends Error {
    code: string;
    category: string;
    constructor(message: string, options: { code: string; category: string }) {
      super(message);
      this.code = options.code;
      this.category = options.category;
    }
  },
}));
vi.mock('@electron/utils/openclaw-managed-models', () => ({
  reconcileGlobalSub2ApiProviders: mocks.reconcileGlobalSub2ApiProviders,
  completeSub2ApiRuntimeModel: (model: string | Record<string, unknown>) => {
    const modelId = typeof model === 'string'
      ? model
      : String(model.modelId ?? model.id ?? '').trim();
    if (!modelId) return null;
    const source = typeof model === 'string' ? {} : model;
    return {
      ...source,
      id: modelId,
      modelId,
      name: typeof source.name === 'string' ? source.name : `LY-${modelId}`,
      input: Array.isArray(source.input) ? source.input : ['text', 'image'],
      contextWindow: typeof source.contextWindow === 'number' ? source.contextWindow : 200000,
      contextTokens: typeof source.contextTokens === 'number' ? source.contextTokens : 200000,
      maxTokens: typeof source.maxTokens === 'number' ? source.maxTokens : 16384,
      timeoutSeconds: typeof source.timeoutSeconds === 'number' ? source.timeoutSeconds : 900,
      reasoning: typeof source.reasoning === 'boolean' ? source.reasoning : true,
      compat: {
        supportsUsageInStreaming: true,
        ...(typeof source.compat === 'object' && source.compat ? source.compat : {}),
        supportsPromptCacheKey: true,
        thinkingFormat: 'qwen-chat-template',
      },
    };
  },
  cleanupSub2ApiEmployeeSecret: vi.fn(),
}));
vi.mock('@electron/utils/digital-employee-model-scope', () => ({
  writeDigitalEmployeeModelScope: mocks.writeDigitalEmployeeModelScope,
  readDigitalEmployeeModelScope: mocks.readDigitalEmployeeModelScope,
  deleteDigitalEmployeeModelScope: mocks.deleteDigitalEmployeeModelScope,
}));
vi.mock('@electron/services/secrets/secret-store', () => ({
  setProviderSecret: mocks.setProviderSecret,
  deleteProviderSecret: mocks.deleteProviderSecret,
}));
vi.mock('@electron/services/providers/provider-runtime-sync', () => ({
  syncSavedProviderToRuntime: mocks.syncSavedProviderToRuntime,
  syncDeletedProviderToRuntime: mocks.syncDeletedProviderToRuntime,
  syncDefaultProviderToRuntime: mocks.syncDefaultProviderToRuntime,
}));
vi.mock('@electron/services/sub2api/model-sync-store', () => ({
  recordSub2ApiSyncStarted: mocks.recordStarted,
  recordSub2ApiSyncSuccess: mocks.recordSuccess,
  recordSub2ApiSyncFailure: mocks.recordFailure,
  listSub2ApiSyncStatus: mocks.listStatus,
}));

import {
  cleanupDigitalEmployeeSub2ApiModels,
  getSub2ApiSyncStatus,
  syncDigitalEmployeeSub2ApiModels,
  syncGlobalSub2ApiModels,
} from '../../electron/services/sub2api/model-sync-service';

function manifest(): DigitalEmployeePackageManifest {
  return {
    schemaVersion: 1,
    package: {
      id: 'com.lyclaw.employee.document-analyst',
      name: 'Document Analyst',
      version: '1.0.0',
      description: 'Analyze docs.',
    },
    agent: { workspaceSource: 'agent/workspace' },
  };
}

function successResult() {
  return {
    userNo: 'EMP001',
    userId: 10,
    provider: { providerId: 'sub2api', protocol: 'openai-compatible', baseUrl: 'https://sub2api.internal.example.com/v1' },
    credentials: [{
      credentialId: 'apiKey-10',
      apiKey: 'sk-test',
      baseUrl: 'https://sub2api.internal.example.com/v1',
      models: [{ modelId: 'deepseek-v4-pro', input: ['text', 'image'], contextWindow: 200000, contextTokens: 200000, maxTokens: 16384, timeoutSeconds: 900, reasoning: true, compat: {} }],
    }],
  };
}

describe('Sub2API model sync service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SUB2API_ENABLED = 'true';
    process.env.SUB2API_BASE_URL = 'https://sub2api.internal.example.com';
    process.env.SUB2API_ADMIN_API_KEY = 'admin-key';
    delete process.env.SUB2API_TIMEOUT_MS;
    delete process.env.SUB2API_ALLOW_HOSTS;
    mocks.getSetting.mockResolvedValue({ jobNumber: 'EMP001', userId: 'user-1' });
    mocks.createSub2ApiClient.mockReturnValue({ fetchUserProviderByUsername: vi.fn().mockResolvedValue(successResult()) });
    mocks.reconcileGlobalSub2ApiProviders.mockResolvedValue({ status: 'updated', modelCount: 1, subjectHash: 'b3fe6919', providerIds: ['p1'] });
    mocks.recordStarted.mockResolvedValue({ lastStartedAt: '2026-07-06T10:00:00.000Z' });
    mocks.recordSuccess.mockImplementation(async (input) => input);
    mocks.recordFailure.mockImplementation(async (input) => input);
    mocks.writeDigitalEmployeeModelScope.mockResolvedValue(undefined);
    mocks.readDigitalEmployeeModelScope.mockResolvedValue(null);
    mocks.deleteDigitalEmployeeModelScope.mockResolvedValue(undefined);
    mocks.setProviderSecret.mockResolvedValue(undefined);
    mocks.deleteProviderSecret.mockResolvedValue(undefined);
    mocks.syncSavedProviderToRuntime.mockResolvedValue(undefined);
    mocks.syncDeletedProviderToRuntime.mockResolvedValue(undefined);
    mocks.syncDefaultProviderToRuntime.mockResolvedValue(undefined);
    mocks.listStatus.mockResolvedValue([]);
  });

  it('skips global sync when DingTalk identity is missing', async () => {
    mocks.getSetting.mockResolvedValue(null);

    const result = await syncGlobalSub2ApiModels('startup');

    expect(result.status).toBe('skipped-missing-subject');
    expect(mocks.createSub2ApiClient).not.toHaveBeenCalled();
  });

  it('uses built-in enterprise Sub2API config when env is unset', async () => {
    delete process.env.SUB2API_ENABLED;
    delete process.env.SUB2API_BASE_URL;
    delete process.env.SUB2API_ADMIN_API_KEY;
    delete process.env.SUB2API_TIMEOUT_MS;
    delete process.env.SUB2API_ALLOW_HOSTS;

    const result = await syncGlobalSub2ApiModels('startup');

    expect(result.status).toBe('success');
    expect(mocks.createSub2ApiClient).toHaveBeenCalledWith({
      baseUrl: 'http://10.0.2.77:8081',
      adminApiKey: 'admin-5f747d46b63a463888d7a4941f0246d50912e06af6eab88d26c582d91c31d855',
      timeoutMs: 5000,
      allowedHosts: ['10.0.2.77'],
    });
  });
  it('promotes the first pulled global Sub2API provider to OpenClaw default runtime', async () => {
    const result = await syncGlobalSub2ApiModels('dingtalk-login');

    expect(result.status).toBe('success');
    expect(mocks.syncDefaultProviderToRuntime).toHaveBeenCalledWith('p1', undefined);
  });
  it('syncs global models and records success', async () => {
    const result = await syncGlobalSub2ApiModels('dingtalk-login');

    expect(result.status).toBe('success');
    expect(mocks.reconcileGlobalSub2ApiProviders).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'global', userNo: 'EMP001' }),
      successResult().credentials,
      expect.objectContaining({ gatewayManager: undefined }),
    );
    expect(mocks.recordSuccess).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'global',
      subjectHash: 'b3fe6919',
      source: 'dingtalk.jobNumber',
      modelCount: 1,
    }));
  });

  it('preserves old global config and records failure when client fails', async () => {
    const client = { fetchUserProviderByUsername: vi.fn().mockRejectedValue(Object.assign(new Error('timeout'), { code: 'timeout' })) };
    mocks.createSub2ApiClient.mockReturnValue(client);

    const result = await syncGlobalSub2ApiModels('startup');

    expect(result.status).toBe('failed');
    expect(mocks.reconcileGlobalSub2ApiProviders).not.toHaveBeenCalled();
    expect(mocks.recordFailure).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'timeout' }));
  });

  it('writes employee model scope and secret on employee sync success', async () => {
    const result = await syncDigitalEmployeeSub2ApiModels({
      manifest: manifest(),
      marketEmployeeId: '123',
      instanceId: 'employee-document-1',
      agentId: 'agent-1',
    }, 'install');

    expect(result.status).toBe('success');
    expect(result).toEqual(expect.objectContaining({ defaultModel: 'custom-sub2ed291be5b/deepseek-v4-pro', modelCount: 1 }));
    expect(mocks.setProviderSecret).toHaveBeenCalledWith({
      type: 'api_key',
      accountId: 'sub2api-employee-employee-document-1',
      apiKey: 'sk-test',
    });
    expect(mocks.writeDigitalEmployeeModelScope).toHaveBeenCalledWith(expect.objectContaining({
      schemaVersion: 1,
      managedBy: 'sub2api',
      scope: 'digitalEmployee',
      userNo: 'document-analyst',
      instanceId: 'employee-document-1',
      provider: expect.objectContaining({
        providerId: 'sub2api-employee-employee-document-1',
        apiKeyRef: 'secret:sub2api-employee-employee-document-1',
      }),
      models: expect.arrayContaining([expect.objectContaining({ modelId: 'deepseek-v4-pro' })]),
      defaultModel: 'custom-sub2ed291be5b/deepseek-v4-pro',
    }));
    expect(mocks.syncSavedProviderToRuntime).toHaveBeenCalledWith(expect.objectContaining({
      id: 'sub2api-employee-employee-document-1',
      name: 'LY-SUB2API',
      type: 'custom',
      model: 'deepseek-v4-pro',
      fallbackModels: ['deepseek-v4-pro'],
      metadata: expect.objectContaining({
        managedBy: 'sub2api',
        scope: 'digitalEmployee',
        hiddenInProviderSettings: true,
      }),
    }), 'sk-test');
  });

  it('records employee failure without replacing model scope', async () => {
    const client = { fetchUserProviderByUsername: vi.fn().mockRejectedValue(Object.assign(new Error('not found'), { code: '40401' })) };
    mocks.createSub2ApiClient.mockReturnValue(client);

    const result = await syncDigitalEmployeeSub2ApiModels({
      manifest: manifest(),
      marketEmployeeId: '123',
      instanceId: 'employee-document-1',
      agentId: 'agent-1',
    }, 'update');

    expect(result.status).toBe('failed');
    expect(mocks.writeDigitalEmployeeModelScope).not.toHaveBeenCalled();
    expect(mocks.recordFailure).toHaveBeenCalledWith(expect.objectContaining({ errorCode: '40401' }));
  });

  it('cleans employee model scope and scoped secret on uninstall cleanup', async () => {
    mocks.readDigitalEmployeeModelScope.mockResolvedValue({
      schemaVersion: 1,
      managedBy: 'sub2api',
      scope: 'digitalEmployee',
      provider: {
        providerId: 'sub2api-employee-employee-document-1',
        protocol: 'openai-completions',
        baseUrl: 'https://sub2api.internal.example.com/v1',
      },
      models: [{ modelId: 'deepseek-v4-pro', name: 'LY-deepseek-v4-pro' }],
      lastSuccessAt: '2026-07-06T10:00:00.000Z',
    });

    await cleanupDigitalEmployeeSub2ApiModels('employee-document-1');

    expect(mocks.syncDeletedProviderToRuntime).toHaveBeenCalledWith(expect.objectContaining({
      id: 'sub2api-employee-employee-document-1',
      type: 'custom',
      model: 'deepseek-v4-pro',
      metadata: expect.objectContaining({
        managedBy: 'sub2api',
        scope: 'digitalEmployee',
        hiddenInProviderSettings: true,
      }),
    }), 'sub2api-employee-employee-document-1');
    expect(mocks.deleteProviderSecret).toHaveBeenCalledWith('sub2api-employee-employee-document-1');
    expect(mocks.deleteDigitalEmployeeModelScope).toHaveBeenCalledWith('employee-document-1');
  });

  it('returns desensitized sync status', async () => {
    mocks.listStatus.mockResolvedValue([{ scope: 'global', subjectHash: 'safehash', status: 'success' }]);

    await expect(getSub2ApiSyncStatus()).resolves.toEqual([{ scope: 'global', subjectHash: 'safehash', status: 'success' }]);
  });
});
