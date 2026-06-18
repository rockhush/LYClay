import { describe, expect, it } from 'vitest';
import {
  applyOpenClawUsageStreamingPatches,
  hasOpenClawUsageStreamingPatches,
} from '../../scripts/openclaw-usage-patches.mjs';
import {
  findProviderItemByModelRef,
  resolveAccountModelRef,
  resolveRuntimeProviderKey,
} from '@/lib/provider-model-ref';
import type { ProviderAccount } from '@/lib/providers';

describe('openclaw-usage-patches', () => {
  it('removes supportsUsageInStreaming gate for stream_options.include_usage', () => {
    const source = [
      'function buildOpenAICompletionsParams(model, context, options) {',
      '  const params = { stream: true };',
      '  if (compat.supportsUsageInStreaming) {',
      '    params.stream_options = { include_usage: true };',
      '  }',
      '  return params;',
      '}',
    ].join('\n');

    const result = applyOpenClawUsageStreamingPatches(source);
    expect(result.patched).toBe(true);
    expect(result.source).not.toContain('if (compat.supportsUsageInStreaming)');
    expect(result.source).toContain('params.stream_options = { include_usage: true }');
    expect(hasOpenClawUsageStreamingPatches(result.source)).toBe(true);
  });

  it('patches single-line supportsUsageInStreaming gate (OpenClaw 2026.5.19 dist)', () => {
    const source = [
      'const params = { stream: true };',
      'if (compat.supportsUsageInStreaming) params.stream_options = { include_usage: true };',
      'return params;',
    ].join('\n');

    const result = applyOpenClawUsageStreamingPatches(source);
    expect(result.patched).toBe(true);
    expect(result.source).not.toContain('if (compat.supportsUsageInStreaming)');
    expect(hasOpenClawUsageStreamingPatches(result.source)).toBe(true);
  });
});

describe('provider-model-ref', () => {
  const lyAutoAccount: ProviderAccount = {
    id: 'ly-auto',
    vendorId: 'ly-auto',
    label: 'LY-Auto',
    authMode: 'api_key',
    model: 'auto',
    enabled: true,
    isDefault: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  const customAccount: ProviderAccount = {
    id: 'customa6',
    vendorId: 'custom',
    label: 'MiniMax Direct',
    authMode: 'api_key',
    model: 'MiniMax-M2.7',
    enabled: true,
    isDefault: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('builds full model refs from account model ids', () => {
    expect(resolveRuntimeProviderKey(customAccount)).toBe('custom-customa6');
    expect(resolveAccountModelRef(lyAutoAccount)).toBe('ly-auto/auto');
    expect(resolveAccountModelRef(customAccount)).toBe('custom-customa6/MiniMax-M2.7');
  });

  it('finds provider items by agent default model ref', () => {
    const items = [
      { account: lyAutoAccount },
      { account: customAccount },
    ];
    expect(findProviderItemByModelRef(items, 'ly-auto/auto')?.account.id).toBe('ly-auto');
    expect(findProviderItemByModelRef(items, 'custom-customa6/MiniMax-M2.7')?.account.id).toBe('customa6');
  });
});
