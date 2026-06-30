/**
 * ly-auto OpenClaw model entry should mirror custom vLLM direct providers
 * (compat only) so context.compiled systemPrompt/tools match for KV cache.
 * Input modalities are synced separately — OpenClaw needs input to forward images.
 */
import { readOpenClawConfig, writeOpenClawConfig } from '../../utils/channel-config';
import { withConfigLock } from '../../utils/config-mutex';
import { logger } from '../../utils/logger';

export const LY_AUTO_DEFAULT_INPUT = ['text', 'image'] as const;

export const LY_AUTO_VLLM_MODEL_OPTIONS: Record<string, unknown> = {
  compat: {
    supportsUsageInStreaming: true,
    supportsPromptCacheKey: false,
    thinkingFormat: "qwen-chat-template",
  },
  reasoning: true,
  input: [...LY_AUTO_DEFAULT_INPUT],
  requestTimeoutMs: 180_000,
};

/** OAuth/provider plugins that change tool inventory when active; off for vLLM paths. */
export const VLLM_COMPILE_PLUGIN_IDS = ['minimax-portal-auth', 'minimax'] as const;

export function normalizeLyAutoInput(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [...LY_AUTO_DEFAULT_INPUT];
  }
  const normalized = input.filter((value): value is string =>
    typeof value === 'string' && value.trim().length > 0,
  );
  return normalized.length > 0 ? normalized : [...LY_AUTO_DEFAULT_INPUT];
}

/**
 * Compile-parity compat + multimodal input for openclaw.json / models.json.
 * Reasoning/context from nginx are intentionally excluded (KV cache parity).
 */
export function buildLyAutoModelOverrides(
  nginxEntry?: { input?: string[] } | null,
): Record<string, unknown> {
  return {
    ...LY_AUTO_VLLM_MODEL_OPTIONS,
    input: normalizeLyAutoInput(nginxEntry?.input),
  };
}

/** Disable OAuth minimax plugins so auto and custom vLLM share the same tool inventory. */
export async function alignVllmCompilePluginState(): Promise<boolean> {
  return withConfigLock(async () => {
    const config = await readOpenClawConfig();
    const plugins = (config.plugins && typeof config.plugins === 'object' ? config.plugins : {}) as Record<string, unknown>;
    const entries = (plugins.entries && typeof plugins.entries === 'object' ? plugins.entries : {}) as Record<string, Record<string, unknown>>;
    let changed = false;

    for (const pluginId of VLLM_COMPILE_PLUGIN_IDS) {
      const entry = entries[pluginId];
      if (entry && entry.enabled === true) {
        entry.enabled = false;
        changed = true;
      }
    }

    if (!changed) {
      return false;
    }

    plugins.entries = entries;
    config.plugins = plugins;
    await writeOpenClawConfig(config);
    logger.info('[ly-auto-compile-parity] Disabled OAuth minimax plugins for vLLM compile parity');
    return true;
  });
}
