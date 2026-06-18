/**
 * ly-auto OpenClaw model entry should mirror custom vLLM direct providers
 * (compat only) so context.compiled systemPrompt/tools match for KV cache.
 */
import { readOpenClawConfig, writeOpenClawConfig } from '../../utils/channel-config';
import { withConfigLock } from '../../utils/config-mutex';
import { logger } from '../../utils/logger';

export const LY_AUTO_VLLM_MODEL_OPTIONS: Record<string, unknown> = {
  compat: {
    supportsUsageInStreaming: true,
    supportsPromptCacheKey: false,
  },
};

/** OAuth/provider plugins that change tool inventory when active; off for vLLM paths. */
export const VLLM_COMPILE_PLUGIN_IDS = ['minimax-portal-auth', 'minimax'] as const;

export function buildLyAutoModelOverrides(): Record<string, unknown> {
  return { ...LY_AUTO_VLLM_MODEL_OPTIONS };
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
